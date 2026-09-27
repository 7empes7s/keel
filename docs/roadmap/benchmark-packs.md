# Benchmark packs, licensing and external scores (task 86)

Implemented at task-85 HEAD e61cf2a, 2026-09-25. Fixture-tested only;
no real CIS permission, Microsoft tenant qualification or certification is claimed.

## Contracts and integration

`engine/benchmarks/packs.mjs` imports bounded JSON packs containing `packId`,
`version`, `edition`, `profile`, and `controls`. Each control references the
existing task-85 authored registry by `controlId` and `evaluatorVersion`, with
optional `frameworkRefs` reference codes. It cannot install executable predicates
or arbitrary licensed control text. ISO, NIS2 and other framework references are
evidence links; they neither duplicate evaluations nor claim certification.
Tests use explicitly synthetic reference codes, not purported normative mappings.
No CIS content or license grant is bundled.

Every import requires a separate rights manifest with edition, profile, SHA-256
of the exact source bytes, redistribution scope (`tenant-only` or `embedded`),
tenant reference and rights-evidence reference. The manifest must match a trusted
reviewed grant, including its scope: tenant-only permission cannot authorize
embedding. Callers must obtain grants from operator-reviewed evidence, never
from the uploaded pack. The validator verifies binding and scope, not the legal
truth of a grant; actual entitlement remains an external qualification gate.

Server-callable import and evaluation functions use the existing `can()` grants
(`configuration` and `read` respectively), not a parallel capability registry.
Packs are immutable and bound to the authorized tenant. Evaluation invokes
`evaluateControl()` once per unique control, rechecks registry versions and
always re-evaluates observation freshness. The cache identity binds source,
rights, pack version, control versions, mappings, profile and tenant.
`packCacheMatches()` is a pure compatibility check, never authorization or proof
of observation freshness. Legacy caches with no versioned pack identity return
false and must be recomputed; historical task-85 evaluations remain untouched.
No persistent schema changes or migration are necessary.

`tools/qualification/benchmarkLicense.mjs` is the offline CLI:

```sh
node tools/qualification/benchmarkLicense.mjs /path/to/local-qualification.json
```

Input is `{ source, rights, grants, tenantRef, use? }`: source is the exact JSON
string, grants are separately reviewed rights manifests, and use defaults to
`tenant-only`. The CLI prints a bounded digest/scope result, never source text,
license documents or credentials. Exit 1 means validation failed. A successful
local fixture check is not live qualification or legal review.

`engine/benchmarks/secureScore.mjs` exposes an authorized read-adapter seam.
The injected adapter has `{ tenantRef, credentialMode: 'collector', credentialRef,
get(path) }`; credentialRef is an opaque reference, never credential material.
The host must bind the adapter to its collector credential store; no credential
acquisition, writer adapter, network client or automatic job is installed here.
Authorization is checked both before and after the read. A mismatched response
tenant is refused. Restorer adapters are refused before any request.

The result preserves Microsoft's score numerator, denominator, source id and
report timestamp separately from its import timestamp and API/credential
provenance. It produces no KEEL pass/fail, external control points, certification,
or zero-risk claim. Missing, empty, malformed, ambiguous, failed, future-dated or
older-than-48-hours data is unknown. A real numeric zero with a valid denominator
remains an external zero score. Provider error details are never exported.
`presentSecureScore()` provides plain-text presentation and treats legacy or
missing results as unknown. Consumers must authorize reads before presentation.

The named task paths provide engine/server seams, presentation and the offline
qualification CLI. There is no named portal page, HTTP route or job kind in this
task; none is added or activated. Inspection found the existing closed portal
inventory at `portal/lib/read.ts:DATA_SURFACES`; it is preserved without adding
an unimplemented live surface. Persistence, scheduled collection and portal
routing are not claimed. This feature stays disconnected from live execution.

## Secure Score qualification ledger

Retrieved 2026-09-25 from official Microsoft documentation:

- https://learn.microsoft.com/en-us/graph/api/security-list-securescores?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/resources/securescore?view=graph-rest-1.0

Declared operation: GET `/v1.0/security/secureScores?$top=1`, no request body.
Collector credential mode only; least-privileged application or work/school
delegated permission is `SecurityEvents.Read.All`. Personal delegated accounts
are unsupported. The published cloud matrix excludes China. Data is daily,
latest-first, with 90 days retained by default; `$top` aggregates provider
results, so ambiguous multi-provider results remain unknown here. The 48-hour
freshness ceiling is KEEL policy, not an atomic tenant snapshot guarantee.

Evidence: injected synthetic readers only, task-86 contract version 1, no live
credential or tenant operation tested. Live support remains unknown until the
orchestrator records tenant/operation/projection/build/credential/time-specific
evidence. No holds or qualification gates were cleared.

## Verification

Boundary tests exercise production imports, the existing registry/evaluator and
authorization query seam, external-score adaptation and presentation, plus the
actual offline CLI with temporary synthetic files. No live Microsoft calls,
notifications, database production writes or service restarts occur. Existing
authz/jobs suites use their isolated local test database helper. Collector and
restorer credentials remain separate; Conditional Access is never enforced.

Requeue review found three missing boundary assertions; production guards were
already present and are preserved. Tests now assert the CLI's explicit
`liveQualified: false`, rejection of a synthetic licensed-provenance registry
control even with matching reviewed pack rights, and an unknown raw import result
with null score fields for a negative Secure Score numerator.

All three required mutation checks were rerun independently and detected:
bypassing rights validation, duplicating evaluations by framework mapping, and
presenting missing Secure Score as zero-risk pass. The three reviewer-derived
mutations (CLI live qualification, negative raw score, and licensed-provenance
pack admission) were also detected. Each yielded 6 passes / 1 failure; every
source mutation was restored byte-for-byte. The unmutated boundary suite passed
all 7 tests.

The subsequent 2026-09-26 requeue identified three additional unexercised guards.
New adversarial tests assert that pack-supplied `certified` relationships become
`evidence-link` at both import and evaluation, an otherwise-valid Secure Score
with missing or spoofed provenance renders unknown, and a reviewed grant for
different source bytes cannot authorize a pack even when all other rights fields
match. Positive controls verify valid presentation and a matching-content grant.
Production guards required no changes.

All three plan-required mutations and these three additional reviewer-derived
mutations were independently killed (each run: 9 passes / 1 failure). Each
production file was restored byte-for-byte after its mutation. The unmutated
boundary suite passes all 10 tests. Earlier mutation results above describe the
previous requeue's seven-test suite.

The latest requeue was inspected at HEAD `dae476f`. Its three reported gaps
were missing tests for existing guards: tenant-specific reviewed grants,
the evaluation's `fixture-tested` qualification, and the presenter's independent
`scoredAt` validation. Tests now reject a foreign tenant's grant for identical
source bytes through both the validator and authorized import, assert fixture
qualification for passing and unknown evaluations, and present otherwise-valid
scores with garbage, empty or missing timestamps as unknown. Matching grants
and valid timestamps retain positive controls. Production code is preserved.

The twelve-test boundary suite passes. All three plan-required mutations, all
three latest reviewer-derived mutations, and the preceding review's source
digest, evidence-link and provenance mutations were killed individually, each
with 11 passes / 1 failure. Production files were restored byte-for-byte after
each mutation and checked using SHA-256. This remains fixture evidence only.

The 2026-09-27 requeue reproduced a production defect: malformed non-string or
empty `azureTenantId` values reached `tenantRefFor()` and threw. The importer now
checks for a nonblank string before deriving a tenant reference and returns
unknown with null score fields for malformed or missing IDs. Valid foreign-tenant
IDs still fail closed with a tenant-mismatch error. A new boundary fixture covers
missing/null/empty/whitespace, numeric, boolean, object and array IDs, including
an array containing the expected ID to guard against coercion. It failed before
the fix and the full thirteen-test boundary suite passed afterward. All three
plan-required mutations were killed again and their source files restored
byte-for-byte. This change uses injected readers only and changes no API route,
credential handling, persistence or live qualification claim.

Final required validation command (from `/opt/keel`):

```sh
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/benchmark-packs.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```
