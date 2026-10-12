# Poll GitHub's lazy mergeable flag before refusing a PR (2026-10-12)

Found while merging the Phase 1 fix PRs: after the merge gate merged one PR, every other
`automerge` PR read `mergeable: null` ("unknown") in the same run and was skipped, so the
queue advanced one PR per gate run and stalled when no new event arrived.

| Mistake | Rule now |
| --- | --- |
| `check_pr` treated `mergeable: null` as "not mergeable yet" on the first read. GitHub computes the flag lazily, only after a read, and resets it for every open PR when the base branch moves. | `check_pr` re-reads the PR up to twelve times, five seconds apart (a minute), while `mergeable` is null. Only a value that is still null, or false, refuses the PR. |
| The stall was worked around by hand (reading each PR, then dispatching the gate). | Nothing to do by hand: one gate run now merges every ready PR in turn. |
