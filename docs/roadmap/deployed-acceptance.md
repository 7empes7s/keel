# Authenticated deployed release acceptance (task 113)

## Status — 2026-10-03

Code half implemented against `origin/master` at `86a5a3d`. **The admission gate stays pending:**
no deployed candidate build has been probed and no authenticated operator session exists in the
build environment, so `docs/release/qualifications/deployed-acceptance.json` is a `status:
"pending"` placeholder that fails `qualification.mjs verify` with or without `--require-live`. No
live evidence was generated, and none can be generated from fixtures.

## What was built

### Gate verifier (`tools/release/qualification.mjs`)

`GATE_VALIDATORS['deployed-acceptance']` is registered additively in the task-45 verifier. It runs
after the existing checks (schema, gate/tenant binding, 30-day freshness, proof, and
`--require-live` rejecting synthetic records, fixture-tested levels and synthetic runners). It
also requires:

- **Identity.** An expected tenant and candidate build must be supplied. The record's `build`
  must equal the candidate, `operation` must be `deployed-acceptance.read-probe` and
  `credentialMode` must be `operator-session`. When no `--tenant` or
  `KEEL_QUALIFICATION_TENANT_REF` is given, the CLI uses the tenant reference of
  `KEEL_TENANT_CONFIG_PATH`, for this gate only. The build defaults to `KEEL_QUALIFICATION_BUILD`
  or the source `HEAD`, as before.
- **Freshness.** The evidence may be at most 7 days old (`DEPLOYED_ACCEPTANCE_MAX_AGE_HOURS`).
  Each probe must fall within the hour before the record's `observedAt`.
- **Both proofs.** The record needs a trusted runner HMAC signature *and* the SHA-256 of the raw
  capture transcript (`proof.artifact`). The transcript must agree with the signed subject on
  tenant, build, deployment and every probe. A fixture runner or a `synthetic: true` record cannot
  carry `evidenceLevel: "live-qualified"`, even without `--require-live`.
- **Deployed identity (prerequisite).** `subject.deployment.revision` must equal the candidate
  build, and the deployed checkout must be clean (`dirty: false`).
- **Probe contracts (prerequisites).** There is a closed inventory, `DEPLOYED_ACCEPTANCE_PROBES`,
  and each surface appears exactly once. A probe outside the inventory is refused.

  | Surface | Prerequisite | Request | Authenticated contract |
  |---|---|---|---|
  | coverage-matrix | task-54 | `GET /api/coverage` | 200 JSON with `generatedAt, snapshot, summary, types` |
  | collection-history | task-46 | `GET /api/jobs?limit=20` | 200 JSON with `generatedAt, jobs` |
  | schedules | task-44 | `GET /api/schedules` | 200 JSON with `schedules, deferrals, forecasts, generatedAt` |
  | restore-review | — | `GET /api/actions/restore/dry-run/00000000-0000-4000-8000-000000000000` | 404 JSON `{"error":"not_found"}` |

  The same request without a session must be refused or redirected to sign-in (301/302/303/307/
  308/401/403). A missing route (an HTML 404), a missing response key, a rejected session (403)
  or an unauthenticated 200 each fail. A failure on a surface with a prerequisite is reported as
  `missing prerequisite task-NN`.
- **Pending records.** A record with any `status` (the capture tool writes `pending`) fails at
  once and lists its `pendingReasons`.

### Capture tool (`tools/release/deployed-acceptance.mjs`)

`node tools/release/deployed-acceptance.mjs capture` is run by the operator on the host. It is
read-only by construction:

- It reads the source and deployed checkouts' `HEAD` and dirty state through the task-45
  `gitRevision` helper.
- It issues only `GET` requests (`redirect: "manual"`) to the four probe paths: once with the
  session assertion in the Access header (`cf-access-jwt-assertion`, the same header as
  `readiness.mjs`) and once without it.
- Each response body is reduced to its status, content type, sorted top-level keys, `error` code
  and SHA-256. Bodies, the session assertion and key material are never written or printed.
- It writes `deployed-acceptance.capture.json` (the transcript) next to the record and signs the
  record as `keel-release-runner` with `KEEL_QUALIFICATION_HMAC_KEY`.
- If the session, tenant config, candidate build, deployed revision or signing key is missing, it
  writes a `status: "pending"` record with reasons instead, and no transcript.
- Its library entry point defaults to `live: false` (synthetic, `keel-fixture-runner`). Only the
  CLI passes `live: true`.

It never executes a restore, writes through the portal, restarts or redeploys anything.

### Boundary tests (`engine/roadmap/deployed-acceptance.test.mjs`)

These run the production capture tool through the real `fetch` against a bounded local HTTP
fixture portal (127.0.0.1, ephemeral port), then run the production verifier on the files it
writes. The tests cover:

- **Valid record.** An independently captured record verifies under `--require-live` (test-only
  key). All probes are GETs, each surface is probed with and without the session, and no session
  material appears in either file.
- **Altered proofs.** These fail: an altered signature, an altered transcript (digest mismatch),
  a missing transcript, and a re-signed record that disagrees with its transcript.
- **Wrong identity.** These fail: wrong tenant, missing tenant, wrong build, missing build, wrong
  operation, wrong credential mode, a transcript from another tenant, a deployed checkout at
  another revision, and a dirty deployed checkout.
- **Stale.** A record older than 7 days fails, and so does a probe outside its observation
  window.
- **Missing prerequisite.** These fail: an absent schedules route, a coverage response without
  `types`, an absent restore-review route, a dropped collection-history probe, and a missing
  deployed identity.
- **Authorization.** An open route (an unauthenticated 200) fails, and so does a rejected
  session (403).
- **Pending.** No session, no tenant, no key or no deployed identity each produce `pending`,
  which never verifies. A record stripped of its proof fails.
- **Fixture elevation.** Fixture evidence passes only without `--require-live`. Relabelling it
  `live-qualified` fails in both modes.
- **Committed file.** The committed evidence file is pending and the real CLI exits 1 under
  `--require-live`.

Required mutation checks (each made in `qualification.mjs`, run, then reverted):

| Mutation | Failing tests |
|---|---|
| Accept missing external evidence (pending returns ok; runner/transcript proofs not required) | 2, 7, 9 |
| Accept mismatched tenant or operation (tenant requirement, operation check, transcript tenant check removed) | 3 |
| Elevate fixture evidence to live-qualified (synthetic/fixture-runner live checks removed) | 8 |

## Limits

- The deployed portal exposes no build endpoint (`/api/health` returns a literal liveness value).
  Build identity therefore comes from the deployed checkout's git `HEAD` on the host. That binds
  the files on disk, not the running process. A portal that was not restarted after a checkout
  change would not be detected.
- The tenant identity is the host's tenant config, not something the probed responses carry.
- The restore-review probe uses a nil-form id and proves only that the route is deployed,
  authorized and answers its JSON not-found contract. It does not render a real dry-run artifact,
  by design, so the probe cannot touch restore state.
- The response contracts check top-level keys and status, not deep schemas or data values.
- Only `--require-live` with the real `KEEL_QUALIFICATION_HMAC_KEY` proves a live claim. The tests
  use a test-only key.
- The verifier binds the record to `--build` / `KEEL_QUALIFICATION_BUILD` / source `HEAD`. If the
  evidence is committed on top of the candidate, `HEAD` moves, so pass the candidate explicitly.

## Operator steps

What is needed: a deployed candidate build whose `/opt/keel-live` checkout is clean and at the
candidate revision, an authenticated operator session (the Cloudflare Access JWT for the portal),
`KEEL_QUALIFICATION_HMAC_KEY` and the host tenant config. Do not restore or redeploy anything as
part of this.

Capture (read-only):

```bash
set -a && . /etc/keel/db.env && set +a
export KEEL_QUALIFICATION_HMAC_KEY=...        # runner key, never committed
export KEEL_PORTAL_SESSION=...                # Access JWT for an operator session, never committed
cd /opt/keel && node tools/release/deployed-acceptance.mjs capture \
  --portal-url https://<portal-host> --source /opt/keel --deployed /opt/keel-live \
  --build "$(git -C /opt/keel-live rev-parse HEAD)" \
  --out docs/release/qualifications/deployed-acceptance.json
unset KEEL_PORTAL_SESSION
```

This writes `deployed-acceptance.json` and `deployed-acceptance.capture.json`. A `pending` result
lists what is missing.

Verify (the task's final validation step):

```bash
set -a && . /etc/keel/db.env && set +a
export KEEL_QUALIFICATION_HMAC_KEY=...
KEEL_QUALIFICATION_BUILD="$(git -C /opt/keel-live rev-parse HEAD)" \
  node tools/release/qualification.mjs verify --require-live --gate deployed-acceptance \
  --evidence docs/release/qualifications/deployed-acceptance.json
```
