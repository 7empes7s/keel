# CLI evidence fixtures must stay within the freshness window

The drill acceptance CLI test used October 3 timestamps while its subprocess
verified evidence against the real clock. On November 3 the 30-day freshness
window expired and Portal CI failed, despite the test passing earlier.

When a test invokes a CLI that checks freshness against the wall clock, derive
its entire evidence timeline from one run timestamp. Keep stale and ordering
mutations relative to that same timestamp, so negative assertions retain their
meaning as time passes. A fixed clock in the in-process verifier alone does not
control a spawned CLI.
