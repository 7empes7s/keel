# Collect every writable field (2026-10-12)

Live gate Q43 step 2: a changed group `description` was never reported as drift and never restored. The restore path was fine; the group `$select` in `tools/tenant-probe/catalog.mjs` had simply never asked Graph for the field, so neither the snapshot nor the live read held it (coverage gap B6).

| Mistake | Rule now |
| --- | --- |
| A type's `$select` was written once and never checked against the fields the restore path is reviewed to write. `engine/contracts/fieldProjection.mjs` listed `description` as writable for groups; the catalogue never collected it. | Every writable field in a type's `knownFields` must be in that type's catalogue `$select`. `engine/roadmap/collect-group-description.test.mjs` checks this for every catalogue entry with a `$select`, so the gap cannot come back silently. |
| The gap was found by a human on the live gate, not by a test: the fixture readers ignored `$select` and returned every field, so collection looked complete. | A fixture Graph that stands in for a `$select` read must answer with only the selected fields, the way Graph does. |
| Adding a field to a `$select` was treated as risky because older snapshots hash differently. | It is a one-time change: the first snapshot after the deploy shows each object of that type as modified once (the new field appears), exactly as #159 (users) and #165 (Intune) did. Say so in the PR; do not bump `HASH_VERSION`, which is for classification-rule changes only. |
