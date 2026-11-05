---
name: keel-pr-checklist
description: Use before you push a branch or open a pull request on KEEL, to self-review the diff and run the checks that QA and CI will run.
---

# Pre-PR self-review

QA reviews every PR in a fresh session and fails it on any of the points below. Check them yourself first.

## 1. The diff

```bash
git fetch origin && git diff --stat origin/master...HEAD && git diff origin/master...HEAD
git log --oneline origin/master..HEAD
```

- **One issue per PR, minimal diff.** No drive-by refactors, renames or formatting.
- **No debug commits**: no probe scripts, temporary CI steps, `console.log` or `.only` (lesson
  2026-10-16-screenshots-and-debug-commits).
- No dead code, duplicate helpers or commented-out blocks. Reuse what exists (`docs/ARCHITECTURE.md` says
  where it lives).
- Comments match the density of the surrounding code.
- **No secrets**: no `.env`, `.key` or `.pem` files, no credentials, no real tenant ids, no unpseudonymised
  object ids, UPNs or SIDs. Fixture names use the `KEEL-RT-` prefix (lesson
  2026-11-04-test-fixtures-host-credentials).
- **Schema**: only additive changes in `engine/store/schema.sql` or a new `engine/store/schema.d/NN-topic.sql`.
  No `DROP`, `TRUNCATE` or `DELETE FROM`: the deploy refuses them.
- **Screenshots**: baselines in `portal/ui-harness/__screenshots__/` change only for the intended change. Commit
  no other images.

## 2. Tests

- No skipped, disabled or quarantined test (`test.skip`, `{ skip: … }`, `todo`). No new `EXCLUDED` entry in
  `tools/engine-test-files.sh`.
- No test that is true by construction: it must fail when the fix is reverted. For a live bug, use the real
  shape (**keel-live-bug-fix** skill). For a restore writer, revert the safety check (**keel-restore-writer**).
- Times set explicitly or relative to now, never the wall clock by accident.
- No test calls Graph, PowerShell or a live tenant. Use fakes only (`tools/qualification/operations.mjs`
  `fakeGraph`, `engine/test/`).
- Tests that pinned an old status or count are updated, not deleted.

## 3. Restore and safety (if the PR touches `engine/restore`, `engine/safety` or `engine/reconcile`)

- No trust, federation, certificate or sign-in endpoint field in any write body (`inboundTrust`,
  `signingCertificate`, `issuerUri`, named-location trust, a task extension's Logic App or sign-in). Each
  becomes a manual step (`trustFieldStep`).
- Tenant-wide writes, deletes and content effects stay behind restore approvals.
- Verification does not hide drift by ignoring fields wholesale.

## 4. Portal (if the PR touches `portal/`)

- Every new page or route goes through `proxy.ts`, and a test shows no assertion gives 401. State-changing
  routes check a capability and refuse cross-site requests (**keel-portal-page** skill).
- Plain English with no raw ids in visible text. Colours from design tokens only.

## 5. Generated files

- `node tools/coverage-doc.mjs --check` passes. If not, run `node tools/coverage-doc.mjs` (**keel-generated-files**
  skill).
- Bring in master if it moved: `git merge origin/master`. Resolve generated files by regenerating and counts by
  recomputing. Never force-push.

## 6. Run the checks

```bash
tools/dev-setup.sh                                   # once: Postgres 16, keel_test, npm ci
cd engine && node --test --test-concurrency=4 $(../tools/engine-test-files.sh)
cd portal && npm run typecheck && npm run build && npm test
cd portal && npx playwright install --with-deps chromium && npm run test:ui   # if components, app or globals.css changed
npm ci --prefix tools/code-health && node tools/code-health/ratchet.mjs check  # lint, dead code, file size
```

The ratchet fails on a new lint or knip finding, or on a file growing past 800 lines (a file already over that
may grow 5% past its baseline). Split a module rather than raising the baseline (`docs/code-health.md`).

Database tests need `KEEL_DB_TEST_URL` (and `KEEL_TENANT_CONFIG_PATH`). In a cloud session `tools/dev-setup.sh`
puts them in the session's env; elsewhere, export the two lines it prints at the end.

Report real exit codes. If a test fails on clean `origin/master` too, show that and say so. Don't call it
unrelated without checking. On Mulinux, run only targeted tests: the full suite, builds and Playwright belong in
a cloud session or CI.

## 7. Docs and state

- `ops/STATE.md`: update it in the same PR when live facts change (a new live gate, a timer, a deploy step), and
  refresh **Last updated**.
- `lessons/YYYY-MM-DD-<topic>.md`: add one when the fix is for a mistake that has happened before (format in
  **keel-live-bug-fix**).
- `docs/ARCHITECTURE.md`: update it if you moved a layer boundary, added a top-level directory or a generated
  file.

## 8. The PR

```bash
git push -u origin <branch>
gh pr create --base master --head <branch> --title "<what changed, plain English>" --body-file <file>
```

The body has:
- **`Closes #<issue>`** (QA fails a PR without it). A gate merge does not close the issue by itself, so check
  it after the merge (lesson 2026-11-03-merged-fixes-leave-issues-open).
- What changed, by file or area.
- How you verified it: the commands, pass and fail counts, and the revert check.
- Assumptions, for example a Graph route taken from the reference rather than live.
- Live capture or re-check steps for the operator, if any.
- A **Self-review** line: what this review found and what you fixed.

The `automerge` label goes on only when CI is green and the independent review has passed. Any push removes
it. The **Portal** workflow runs on PRs that touch `portal/`, `engine/`, `cli/`, `tools/`, `ops/powershell/`, the root
`package.json` or `.github/workflows/portal.yml`, and it must be green on the head commit.
