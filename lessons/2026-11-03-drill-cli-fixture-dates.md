# Drill CLI evidence fixtures expired

The drill live acceptance CLI test wrote October 3 evidence and verified it
against the subprocess wall clock. After 720 hours the test failed on master
and blocked unrelated PRs, even though the in-process verifier tests still
passed with their fixed clock.

Keep fixtures used by a CLI that verifies freshness relative to the run time.
Derive drill start, reconstruction completion, observation, and deliberately
stale dates from one reference time so their ordering and age assertions stay
consistent. Do not relax the production freshness limit to repair a fixture.
