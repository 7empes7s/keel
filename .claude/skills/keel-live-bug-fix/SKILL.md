---
name: keel-live-bug-fix
description: Use when you fix a bug that was found live on the test tenant or the live portal (an issue that cites an operator queue item Q<n> or K<n>, or live evidence).
---

# Fixing a live bug (Q-numbered)

Live bugs come from the operator queues: `ops/operator-queue.md` on branch `claude/operator-queue` (items
`Q<n>`) and `ops/keelops-queue.md` on `claude/keelops-queue` (items `K<n>`). The queues are never merged into
master. The issue quotes the evidence: Graph or cmdlet answers, a restore log, a dry run.

The fix is accepted only when **a test with the real shape fails without the fix and passes with it.**

## 1. Check that it isn't already fixed

```bash
git log origin/master --oneline --grep="#<issue>"
git log origin/master --oneline --grep="Q<n>"
```
If a merged PR already covers it, verify with its tests and say so on the issue instead of fixing it twice
(lesson 2026-11-03-merged-fixes-leave-issues-open).

To read the queue item: `git fetch origin claude/operator-queue && git show origin/claude/operator-queue:ops/operator-queue.md`.

## 2. Take the shape from the evidence

- Copy the payload **exactly as live returned it**: field names, casing, `@odata.type` present or missing,
  enums as numbers (PowerShell `ConvertTo-Json`), id formats, empty lists versus missing fields, paging
  (`@odata.nextLink`).
- Committed live records are in `docs/release/qualifications/` (`entra-live/` for Entra). Prefer them, or the
  issue text, over the Graph reference.
- Pseudonymise before you commit: tenant ids, object ids, UPNs and SIDs (lesson
  2026-10-12-pseudonymize-sids; `tools/qualification/pseudonymize.mjs`). Name fixtures with the `KEEL-RT-`
  prefix. Never commit a credential, a `.env`, a key file or a real tenant id.
- If the bug depends on what the database stores, the test must store and read back through
  `engine/store/db.mjs`, not pass the in-memory shape (lesson 2026-10-14-fixture-shape-vs-stored-shape).

## 3. Write the failing test first

- Put it next to the code it covers (`engine/<area>/<module>.test.mjs`) or in `engine/roadmap/<topic>.test.mjs`
  for a restore or ledger behaviour. Portal: `portal/test/<topic>.test.ts`.
- Drive the production path (`applyWave`, `collectSnapshot`, `buildReconciliationPlan`, the route handler).
  Don't use a copy of the logic. Use the in-memory fakes: `fakeGraph()` in `tools/qualification/operations.mjs`,
  `engine/test/idoFakeGraph.mjs`, and `engine/test/fake*.mjs` for cmdlets, DSC, PnP and SharePoint REST.
- Name the test after the behaviour and cite the item, for example
  `test('a group read with no members list is not "no members" (Q213)', ...)`.
- **Time:** set dates explicitly, or relative to `now` for anything a window or retention rule compares. Never
  depend on the wall clock by accident (lessons 2026-10-14-fixed-dates-in-windowed-tests,
  2026-10-15-js-dates-vs-postgres-microseconds).
- Run it and **see it fail for the reason in the issue**. A test that fails for another reason proves nothing.

## 4. Fix, then do the revert check

1. Make the smallest fix in the layer where the bug lives (see `docs/ARCHITECTURE.md`). Do not widen a
   field-ignore list to hide drift; fix the comparison or the read.
2. Run the new test: it passes.
3. **Revert check:** set the fix aside without the shared stash, run the test, and see it fail:
   ```bash
   patch="$(git rev-parse --git-dir)/revert-check.patch"
   git diff -- <fixed files> > "$patch" && git checkout -- <fixed files>
   (cd engine && node --test <your test file>)    # must fail
   git apply "$patch" && rm "$patch"
   ```
   Never use a bare `git stash` / `git stash pop`: the stash stack is shared between worktrees.
4. Write the result in the PR: "reverted `<function>` in `<file>`, test `<name>` failed with `<message>`".

## 5. Look for the same shape elsewhere

The same mistake often lives in a sibling module (lesson 2026-11-04-same-slow-shape-elsewhere). Grep for the
pattern you fixed, for example the same `$select`, the same enum comparison, or the same `DISTINCT ON` query.
Fix the siblings in this PR only if they belong to the same issue. Otherwise list them in the PR.

## 6. Lesson file when the mistake repeats

If the same kind of mistake has happened before (grep `lessons/` for it), add
`lessons/YYYY-MM-DD-<short-topic>.md` in the same PR. Use the format of the existing files: a `#` title with the
date, two or three sentences of what happened (issue and PR numbers, Q number), then a table:

```markdown
| Mistake | Rule now |
| --- | --- |
| <what went wrong> | <the rule, naming the function or file that enforces it> |
```

A demotion record (`*.demotion.json`) also needs its `liveFailures` entry in `TYPE_DECISIONS`, plus a
regenerated `docs/coverage.md`, in the same PR (lesson 2026-10-14-demotions-need-live-failures).

## 7. Live re-check

Builders never touch the tenant. In the PR, write the operator's re-check as numbered steps on a `KEEL-RT-`
fixture. If live facts change, update `ops/STATE.md` (for example "Open live gates"). Then follow the
**keel-pr-checklist** skill.
