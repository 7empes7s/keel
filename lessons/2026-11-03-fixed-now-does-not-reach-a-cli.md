# A fixed `now` does not reach a CLI the test spawns

On 2026-11-03 the engine suite turned red on every branch with no code change:
`engine/roadmap/drill-live-acceptance.test.mjs` built its drill at `2026-10-03` and passed a fixed `now` to the
in-process `verifyEvidence` calls, so those passed. But one test runs `tools/release/qualification.mjs verify` as a
child process, which reads the real clock. Thirty days later the drill was older than the 720 h freshness window.

| Mistake | Rule now |
| --- | --- |
| A fixture used calendar dates because in-process calls got a fixed `now`, while a spawned CLI read the wall clock | When a test spawns a CLI that checks freshness, build every fixture time relative to `Date.now()` (see the `at()` helper in that test) |
