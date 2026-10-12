# A test timeout must outlast process start-up on a loaded runner (2026-10-12)

Found while merging the Phase 3 PRs: `cli/keel-worker.test.mjs` failed on PRs that never touched the worker, and passed
when run alone. Its timeout case gave the spawned child 100 ms, which is less than Node needs to start under four
parallel test files, so the child was sometimes killed before it wrote the grandchild pid file the test then read.

| Mistake | Rule now |
| --- | --- |
| A timeout in a test was set close to the real cost of the work it interrupts (starting a Node process). | A timeout a test waits on is seconds, not milliseconds, unless the test is about that exact bound. The worker timeout case now uses 3000 ms. |
| The failure was read as "flaky" on unrelated PRs. | A test that fails only under parallel load is a race in the test; reproduce it with several copies at once and fix it. |
