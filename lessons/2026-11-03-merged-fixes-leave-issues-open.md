# Merged fixes left their issues open

Issue #683 (a Microsoft 365 group update reported as residual drift) was fixed by PR #686 on 2026-10-29, and
its follow-up (an enforce writing what the approved dry run did not plan) by PR #687 the same day. Both merged,
yet the issue was still open on 2026-11-03 and was handed to a builder a second time.

PR #686's body said `Fixes #683` and GitHub linked them (`closingIssuesReferences` is `[683]`), but the issue
was not closed on merge. The Merge gate merges with the workflow's `GITHUB_TOKEN`, and none of the 15 most
recently closed issues was closed by a merge: each was closed by hand. On 2026-11-03, 12 open issues had fix
commits on master that name them (#640, #642, #646, #663, #681, #683, #684, #695, #700, #704, #705, #720).
Some of those may be partial fixes, so each needs a check before it is closed.

| Mistake | Rule now |
| --- | --- |
| A closing keyword in a PR was trusted to close the issue, but gate merges don't | After a fix PR merges, check the issue's state and close it by hand if it is still open |
| A builder started on an issue without checking whether it was already fixed | Before starting, run `git log origin/master --oneline --grep="#<issue>"` and read the PRs it finds. If they already cover the issue, verify with their tests and close the issue rather than fixing it again |
