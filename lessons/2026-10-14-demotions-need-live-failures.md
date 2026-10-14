# A demotion record needs its liveFailures entry in the same PR

**What happened (2026-10-14):** the Q45 live evidence PR (#203) committed four new
`*.demotion.json` files under `docs/release/qualifications/entra-live/`. It did not
update `TYPE_DECISIONS[type].liveFailures` in `engine/coverage/qualification.mjs`.
The test "committed demotions are applied" then failed on master and on every open PR.

**Rule:** a PR that adds or replaces a demotion record also updates the matching
`liveFailures` entry: the demotion's date, its exact reason and the fix.
Then it regenerates `docs/coverage.md` with `node tools/coverage-doc.mjs` and runs
`roadmap/entra-live-gate.test.mjs` before pushing. Evidence-only PRs are not exempt.
