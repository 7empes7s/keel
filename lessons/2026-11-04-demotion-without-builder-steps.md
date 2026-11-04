# A live demotion lands with its builder steps, never alone

Q268 (#951) and Q271 (#952) committed `*.update.demotion.json` records for
`tenantAppManagementPolicy` and `defenderRoleAssignment` without the builder
steps each record lists. `entra-live-gate.test.mjs` then failed (a committed
demotion not applied), and so did the acceptance harness test, which assumed
no demotion was still deciding. Master stayed red, so nothing deployed.

A demotion record and its builder steps go in the same PR. Either take the
write out of `engine/coverage/capabilities.d/` and say why in
`TYPE_DECISIONS` (manual when no operation is left), or keep it registered and
record the failure and its fix under `TYPE_DECISIONS.<type>.liveFailures`.
While a demotion has no newer live record, the release ledger shows the write
as demoted and readiness as blocked; the harness test now expects exactly that
instead of assuming there are none.

Before merging an evidence PR, run
`node --test engine/roadmap/entra-live-gate.test.mjs engine/roadmap/acceptance-harness.test.mjs`
and wait for green CI on its head commit.
