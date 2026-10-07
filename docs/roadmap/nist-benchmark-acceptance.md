# NIST SP 800-53 benchmark qualification

Task 119 restores the exact reviewed pin from commit e4d8ef8 (absent from this
checkout's HEAD). No catalog was fetched. The external 5.2.0 OSCAL catalog hashes
to 01f37cf90ea99d92242c936cbfbdebcc338eef1f71454e2acac36cc56e9bc062.
Its recorded source URL and retrieval timestamp remain in the pin. Public-domain
content admission requires no purchased license or separate rights artifact.

`loadNistProfile` hashes actual bytes before parsing and imports the 68 base
controls in AC, IA, AU and CM. Enhancements remain outside this representative
profile. `importNistPack` uses the existing authorized pack import/evaluation
seam and maps the three existing original KEEL checks to AC-6, AC-3 and AC-2.
These are limited evidence links, never complete implementation or certification
of a NIST control. IA, AU and CM have no automated KEEL checks in this profile;
loading their reference content does not claim coverage. No external predicates
are executed. The pin's legacy spelling `public domain` is normalized to
`licensing.status: public-domain` in the manifest. Only manifests created from
the verified pin receive this admission; uploaded public-domain assertions
cannot bypass the generic reviewed-grant requirement for proprietary content.

The existing release CLI now verifies the NIST gate. Its expected tenant comes
from `--tenant` or `KEEL_QUALIFICATION_TENANT_REF`; build comes from `--build`,
`KEEL_QUALIFICATION_BUILD`, or current Git HEAD. Expected operation is
`nist-benchmark-evaluate`, credential mode `collector`. Evidence must bind the
source URL, catalog digest/version, profile and task-86 prerequisite in `subject`,
and carry `fixtureResults` for each mapped control with pass/fail/missing outcomes
(as specified in the boundary test). A trusted runner signature covers that
identity and all results; any supplied artifact digest must also verify.
Normal timestamp and synthetic-runner restrictions remain enforced. Verification
rechecks the actual pinned catalog, so a missing or substituted prerequisite fails.
NIST verification rejects fixture evidence claiming `live-qualified` even when
the caller omits `--require-live`; explicitly fixture-tested records remain
verifiable without that flag and never satisfy the production gate.
The orchestrator supplies independently captured evidence and the verification
key through the existing verifier contract; this builder supplies neither.

The checked-in qualification record is explicitly pending, not a successful
production record. Public-domain source admission is satisfied; tenant/build
qualification remains pending until authentic runner evidence exists. The final
`--require-live` command must fail in that state. Tests use a test-only signing
key to exercise the contract and never persist signed fixture records as release
evidence. No live API, writer, restorer, notification, or service restart is used;
Conditional Access is never enforced.

No database schema or UI path is named by this task; no migration or parallel
portal gate is introduced. Existing pack cache identity and legacy-cache refusal
remain unchanged. Legacy release records missing the NIST identity/prerequisite
fields fail closed and require new runner evidence. Authenticated callers receive
results through the existing pack seam; evaluation stays fixture-tested.

## Operator steps

The capture (`tools/qualification/nistLive.mjs`, added for task 124's one-build recapture) runs on
the host that holds the pinned catalog at the build being qualified. It only reads the KEEL database
(principal and role grants) and calls no tenant API. The principal must hold `configuration`.

```bash
KEEL_QUALIFICATION_HMAC_KEY=... node tools/qualification/nistLive.mjs capture --live \
  --db-url "$KEEL_DB_URL" --principal-email <operator email> --tenant <tenant_ref> \
  --build <rev> --out docs/release/qualifications/nist-benchmark-acceptance.json
KEEL_QUALIFICATION_HMAC_KEY=... node tools/release/qualification.mjs verify --require-live \
  --gate nist-benchmark-acceptance --tenant <tenant_ref> --build <rev> \
  --evidence docs/release/qualifications/nist-benchmark-acceptance.json
```

Without `--live` the record is signed as `keel-fixture-runner` and never satisfies `--require-live`.
If any mapped control does not give pass, fail and unknown for its three scenarios, no record is written.
