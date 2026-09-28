# External evidence checkpoints (task-78)

Fixture-tested only; production publication is disabled pending independent
storage/key qualification and authentic runner evidence. No tenant writes,
notifications, services, credentials or qualification gates are changed.

The task-67 storage adapter hosts version-1 signed checkpoints outside the primary
DB. Each checkpoint binds tenant, global sequence, chain hash, tenant record count,
build, independent storage reference and versioned Ed25519 key identity. A signer
callback holds private material outside stored metadata. Publication validates the
signature, uses a content-addressed object, and checks readback; retry of identical
bytes is idempotent. A successful publication returns the independent object
reference, not an executed Microsoft operation. Publication failures throw and
must not be recorded by a runner as successful. The reference must be pinned by
the orchestrator outside the DB; accepting a DB-provided old reference defeats
rollback detection. Local disk is a fixture medium, never immutable storage.

Verification explicitly requires independent storage trust, available trusted
public keys, tenant/build matching, valid signatures, and an externally pinned
root key. Rotation carries a domain-separated old-key signature binding the next
key identity and exact public key; every key must also exist in the external
trust registry. Unknown keys, missing storage, missing anchors, bad signatures,
and absent production qualification fail closed as unanchored. Production mode
requires live-qualified immutable storage/read and key trust; fixture mode returns
fixture-tested and cannot establish production trust. Trust metadata is an injected
operator dependency, never derived from evidence_head or request parameters.

A repeatable-read DB transaction preserves a coherent internal verification and
external comparison. Truncation below the checkpoint fails even if the internal
head was rewritten. Coherent forgeries fail at the checkpoint sequence. Internally
broken hashes report broken-at-sequence. Verified results identify the anchored
sequence and count later, internally consistent but externally unanchored records.
Global sequence gaps from other tenants are legitimate; counts are tenant scoped.

Every new publisher/verifier entry requires a current authorization callback before
reads; publication checks again before storage writes. Callers must bind tenant
scope to their authenticated context and use existing capability checks. The
existing portal evidence:verify/read guard supplies this context. The CLI now
requires --principal-id and rechecks the existing read capability. Portal and CLI
report unanchored by default: no production trust provider is configured or
invented. Independent runners can inject the storage, pinned reference, build,
trust registry, signer and authorization into the engine APIs after qualification.
There is no new endpoint, job, capability gate, or alternate restore engine.

No schema migration or historical hash rewrite is required. Legacy evidence keeps
its internal verifier and task-77 envelopes; a legacy chain without an independent
checkpoint is explicitly unanchored on operator surfaces. Version-1 external
objects are additive; unsupported object versions are refused. No external vendor
API is used. Collector/restorer credentials remain separate; Conditional Access
is never enforced.

Boundary tests use an isolated DB and temporary local storage with real ephemeral
Ed25519 signatures. They cover tampering both records and head, truncation,
foreign tenant/build, unknown key, signature damage, missing trust, authorization,
authenticated rotation, and uncovered tail records. These prove implementation
behavior only, not cloud immutability, key custody, provider availability or live
recovery. Required mutations are run separately and restored before validation.

## Local verification

All three required mutations were killed independently (each run: 8 passed,
1 failed), then restored: bypass external hash comparison, bypass truncation
classification, and accept an unknown checkpoint signing key. The coherent
forgery fixture preserves original sequences and rewrites both records and head.
Rotation tests additionally reject a damaged old-key continuity signature. The
publication retry test verifies the same external reference without overwriting.
The evidence/event-envelope regression run passed 16 tests, portal evidence
integration passed 3 tests, and portal TypeScript checking passed. These runs
used only fixtures and the isolated test database. Production trust is pending.

Requeue coverage adds three independent boundary tests for the existing guards:
production key qualification with a simulated qualified storage provider (so the
storage gate cannot mask a fixture-only signing key), replay of correctly signed
bytes under a different pinned storage reference, and authorization revoked by
the signer before publication. The revocation test checks that no external read
or publish occurs and that storage remains empty; an authorized retry succeeds.
Positive controls verify that qualified synthetic keys and correctly bound
storage references pass. Synthetic qualification claims exist only in test
inputs and do not qualify local disk or any production key/provider.

All three derived mutations were killed independently (each run: 8 passed,
1 failed): removing checkpoint storage-reference pinning, bypassing production
key qualification, and removing the second publication authorization check.
All six mutations were restored exactly. The unmutated boundary suite passes
9 tests; compatible production guards were retained without redesign.

The second requeue adds coverage for the three further reviewer mutations:
the adapter rejects a trust registry whose storageRef differs from the caller
before storage IO (with a checkpoint that still matches the caller); both engine
entry points reject an omitted authorization callback and non-true decisions
before DB/storage IO; and fully signed rotations back to either the root or an
abandoned intermediate key ID fail verification and publication. Valid pins,
authorization and a forward three-key rotation provide positive controls.
All three existing production guards were retained. Each derived mutation was
killed independently (11 passed, 1 failed), and the three required mutations
were rerun with the same result. Each source mutation was restored byte-for-byte.
The unknown-key mutation bypassed authentication for an absent key; a preliminary
replacement with an unrelated public key still rejected the signature and did
not implement the intended acceptance mutation. The restored boundary suite
passes all 12 tests. These checks use only temporary storage and isolated DBs.

The third requeue closes the remaining publication coverage gaps while retaining
the existing production guards. Exact readback is required after both a new
publication and an idempotent retry; corrupt bytes and unavailable readback each
reject publication. Every checkpoint metadata field (build, keyId, tenantRef)
rejects synthetic password assignments, bearer tokens and private-key markers
before DB access, signing or storage IO, without echoing the value in the error.
The production publish-capability test qualifies all other synthetic dependencies
and independently refuses declared, fixture-tested, unsupported and unknown
publish claims before IO. Successful publication and verification provide positive
controls. Synthetic qualification metadata never qualifies any real provider.

Removing readback verification, each of the three metadata credential checks
individually, or the production publication gate now fails its boundary test
(each mutation run: 14 passed, 1 failed). No production guard was redesigned.
The three plan-required mutations were also killed independently (14 passed,
1 failed each). All eight mutations were restored byte-for-byte before final
validation, and the boundary suite passes all 15 tests.
