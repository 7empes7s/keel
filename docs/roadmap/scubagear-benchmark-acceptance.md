# CISA ScubaGear benchmark pack qualification (task 126)

Implemented against HEAD `efeb7af`, 2026-09-27 (uncommitted task work). Fixture-tested only; no live
Microsoft 365 tenant has been evaluated against any ScubaGear check, and no
compliance certification of any kind is claimed.

## Contracts and integration

`tools/release/qualification.mjs` gains `importScubaGearProfile()`, which
reads the existing pin at `docs/roadmap/benchmark-content/scubagear-pin.json`
(CISA ScubaGear, CC0-1.0 public domain — a U.S. government work product,
requiring no purchase, membership or redistribution-rights artifact, read
exactly the way task-119 reads NIST's public-domain status from its own pin)
and imports a representative profile of the `aad` and `exo` Rego baselines
from the reference content pinned outside git at
`/var/lib/keel/reference-data/scubagear/`. Every imported file — the NIST
cross-reference CSV and each workload's Rego policy file — is read and its
SHA-256 checked against `MANIFEST.sha256` before any byte of it is trusted;
a mismatch (corruption, substitution, or a manifest with no entry for the
file) throws before import, never silently passing through. `PolicyId`
values are extracted from the verified Rego source by pattern (the module
never evaluates Rego or OPA; it identifies which checks exist), then each is
cross-referenced against `mappings/scuba-to-nist-sp-800-53-r5-fedramp-high.csv`
to produce a `nistControlIds` evidence-link array. A ScubaGear check with no
row in that CSV is not surfaced — the imported profile is a coherent citation
chain (ScubaGear check -> NIST control ID -> the already-pinned NIST catalog),
not a claim that every check maps to something.

The importer is pure/offline: no network access, no credential material, no
tenant read or write, and no execution of the Rego policies themselves. It
is deterministic given the pinned commit's content, and is re-run on every
gate verification rather than cached, so a corrupted or substituted local
copy is caught at verify time, not only at the moment of the original import.

`GATE_VALIDATORS['scubagear-benchmark-acceptance']` is registered additively
in the existing task-45 qualification verifier (the same registry
`release-readiness` already uses; no parallel gate mechanism was created).
Beyond the qualifier's existing generic checks (schema, gate/tenant binding,
observation freshness, proof, and `--require-live`'s rejection of synthetic
fixtures, fixture-tested levels and synthetic runner identities), the gate's
own subject validator requires:

- `operation` equals the exported `SCUBAGEAR_BENCHMARK_OPERATION` constant
  (`scubagear.benchmark-acceptance`) — evidence produced for any other
  operation is refused, not just cross-tenant evidence.
- `subject.sourceCommitSha` matches the pin's `commitSha` exactly.
- `subject.manifestVerified === true` — an explicit attestation that the
  MANIFEST.sha256 check ran; evidence is refused without it (a missing
  prerequisite).
- `subject.workloadsImported` includes at least `aad` and `exo`.
- Every entry in `subject.policiesEvaluated` names a `policyId` that is
  actually present in the freshly re-verified imported profile (a forged or
  no-longer-current policy id is refused), carries the exact
  `nistControlIds` mapping from the verified CSV, and a verdict from the same
  `pass`/`fail`/`not-applicable`/`unknown` vocabulary the rest of KEEL uses.

## Evidence and CLI

```sh
node tools/release/qualification.mjs verify --gate scubagear-benchmark-acceptance --evidence <file> [--require-live] [--tenant <ref>] [--build <revision>]
```

is the same CLI task-45 already ships; no new command was added. The
committed evidence scaffold at
`docs/release/qualifications/scubagear-benchmark-acceptance.json` is a
schema-valid, honestly-labeled `fixture-tested`/`synthetic: true` record
proving the wiring is correct — every policy in the real imported `aad`+`exo`
profile, each with its real mapped NIST control id(s) and an `unknown`
verdict (no tenant was read). Its proof is an independently verifiable
artifact digest (`docs/release/qualifications/scubagear-benchmark-acceptance.artifact.json`,
a snapshot of the imported profile), not an HMAC signature, since no
`KEEL_QUALIFICATION_HMAC_KEY` exists in this environment. Per Global
Constraint 3, this record can never satisfy `--require-live` on its own —
that requires a real ScubaGear/OPA run against a real tenant, signed by the
non-synthetic `keel-release-runner` identity with `evidenceLevel:
'live-qualified'`. No hold was cleared and no live claim is fabricated here.

## Verification

Boundary tests exercise the production importer against the real, read-only
pinned reference data (never mutated) and, for the adversarial manifest-tamper
cases, an isolated temporary copy so the shared fixture is never at risk.
Tests cover: a valid aad+exo import with correct NIST evidence links and the
expected 31+12 = 43 mapped-check count; an unmapped check correctly excluded;
a non-public-domain pin rejected; a byte-tampered policy file, a manifest
missing an entry, and a substituted mapping file all refused before import;
and the qualification gate's schema, proof, freshness, tenant, operation,
source-commit, manifest-attestation, workload-coverage, unknown-policy-id and
`--require-live` checks, plus a CLI end-to-end pass/fail run mirroring
`foundation.test.mjs`'s coverage of `release-readiness`.

All four required mutation classes were applied locally and killed on this
run: missing proof (3 failures), tenant mismatch (2), operation mismatch (1),
fixture elevation (1), and bypassed file hash comparison (2). The production
file was restored exactly after the mutations. The boundary suite now has
19 tests, including altered signature/digest, wrong expected build, forged
NIST mapping, absent evaluated workload and restorer credential rejection.
The foundation and benchmark-pack regression suites pass with the isolated
test database environment loaded.

The verifier API accepts an expected `build`; the CLI exposes it as `--build`.
Callers must supply the expected tenant/build to bind qualification to their
release context; the fixed ScubaGear operation and collector-only credential
mode are always checked. Both aad and exo must have evaluated policy entries.
No database schema changes or migration are needed. Existing fixture records
remain readable; records with incorrect mappings or incomplete coverage now
fail closed. This task names no portal route or UI file: integration uses the
existing verifier API and CLI JSON result, without adding another gate or UI.

All reference content files were checked against the local manifest before
inspection. Its self-entry is excluded from this inspection because a
manifest cannot authenticate itself. The local pin/manifest remain trusted
operator inputs, not a cryptographic upstream signature. Rego dependencies
are not executed by this bounded metadata importer. No live API is invoked,
no credentials are combined and no Conditional Access policy is enforced.

Final required validation command (from `/opt/keel`):

```sh
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/scubagear-benchmark-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate scubagear-benchmark-acceptance --evidence docs/release/qualifications/scubagear-benchmark-acceptance.json
```

The test suite passes; the final `--require-live` check exits nonzero by
design (`--require-live rejects synthetic fixtures`) — external readiness
remains pending until an authentic runner records real evidence, exactly as
Global Constraints 3 and 12 require. The full validation therefore remains failed pending authentic external
evidence; fixture verification does not complete live qualification.
