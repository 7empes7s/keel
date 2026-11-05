# Code health

Measured on master at `f057e293` (2026-11-04). This page has three parts: what we measured and
how, the guardrails CI now runs, and a cleanup backlog in priority order. Every number below can be
measured again with the commands shown.

## Guardrails (CI)

The **Lint, dead code and file size (ratchet)** job in `.github/workflows/portal.yml` runs
`node tools/code-health/ratchet.mjs check`. It runs three checks and compares the results with
`tools/code-health/baseline.json`:

| Check | What it looks at | Config |
|---|---|---|
| ESLint (flat config, type-aware) | engine/, cli/, tools/, status/ (`.mjs`): `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `eqeqeq` (`== null` allowed), `no-unused-vars`, `eslint:recommended`. portal/ (`.ts`, `.tsx`): the same, plus `typescript-eslint` recommended, `react-hooks` recommended and the `next` recommended and core-web-vitals rules | `tools/code-health/eslint.config.mjs`, with `tsconfig.engine.json` giving the `.mjs` files their types (allowJs, no checkJs) |
| knip | unused files, unused exports and types, and duplicate exports across the whole repository. The portal's imports of engine modules count as uses | `tools/code-health/knip.json`. The root `package.json` exists only so that knip can see across folders |
| File size | every tracked `.mjs .js .ts .tsx .ps1 .psm1 .sh` file | A file already over 800 lines may grow to at most its baseline plus 5%. Every other file, including new ones, stays at 800 lines or fewer |

**How the ratchet works.** The baseline counts violations per file and per rule, with no line
numbers, so ordinary edits don't move it. CI fails when any (file, rule) count goes above its
baseline. Fixing a violation never fails CI. The check prints the fixed counts, and
`npm --prefix tools/code-health run baseline` (`ratchet.mjs update`) lowers the baseline to match.
`update` never raises a count. It writes sorted JSON, so the same counts always give the same file
(tested in `tools/code-health/ratchet.test.mjs`, which runs with the engine suite).
`update --reset` rebuilds the baseline from scratch. Use it only for a deliberate move, such as
renaming a file that has known violations, and say why in the PR.

Run it locally:

```sh
npm ci --prefix tools/code-health   # plus engine/ and portal/ installs, for types
node tools/code-health/ratchet.mjs check
```

This takes about 4 minutes on a CI runner, mostly the type-aware ESLint run. The engine and portal
halves run as two processes because a single program does not fit in a default Node heap.

**Baseline at introduction:** 263 ESLint findings in 142 files, 982 knip findings in 295 files
(901 unused exports, 79 unused types, 2 duplicate exports), and 51 files over 800 lines.

## Measurements

### Largest files

`node tools/code-health/measure.mjs files`

| File | Lines |
|---|---|
| `portal/ui-harness/ui.spec.ts` | 6513 |
| `portal/ui-harness/app.tsx` | 3442 |
| `engine/restore/intuneOperations.mjs` | 2902 |
| `cli/keel-restore.mjs` | 2484 |
| `engine/restore/intuneExtended.test.mjs` | 2428 |
| `engine/restore/applyEngine.mjs` | 2344 |
| `portal/lib/portal-data.ts` | 2051 |
| `engine/restore/identityObjectOperations.test.mjs` | 1580 |
| `engine/coverage/qualification.mjs` | 1575 |
| `engine/restore/identityObjectOperations.mjs` | 1360 |
| `engine/roadmap/keel-recovery.test.mjs` | 1264 |
| `portal/lib/compliance-view.ts` | 1241 |
| `cli/keel-restore.test.mjs` | 1228 |
| `tools/qualification/operations.mjs` | 1221 |
| `engine/safety/contentEffects.mjs` | 1193 |

### Longest and most complex functions

`node tools/code-health/measure.mjs functions` uses ESLint's `complexity` (cyclomatic) and
`max-lines-per-function` rules, excluding blank and comment lines. Test files are left out.

It measured 17,580 functions: 483 have complexity over 20, 78 over 50, and 147 are longer than
100 lines.

| Function | Lines | Complexity |
|---|---|---|
| `cli/keel-restore.mjs:341` `runRestore` | 1006 | 416 |
| `engine/restore/applyEngine.mjs:535` per-operation callback inside `applyWave` | 668 | 311 |
| `engine/restore/applyEngine.mjs:444` `applyWave` | 764 | 33 |
| `portal/ui-harness/app.tsx:3032` `Page` | 343 | 158 |
| `tools/qualification/onedrivePurviewAcceptance.mjs:390` `validateOneDrivePurviewLiveSubject` | 123 | 133 |
| `tools/qualification/teamsAcceptance.mjs:242` `validateTeamsLiveSubject` | 124 | 118 |
| `engine/restore/recordWriter.mjs:689` `applyRecordWrite` | 150 | 114 |
| `tools/qualification/operations.mjs:673` `write` | 189 | 114 |
| `portal/components/restore-selection.tsx:408` `RestoreSelection` | 623 | 112 |
| `engine/restore/workloads/sharepointSitePermissions.mjs:218` `planSitePermissionsRestore` | 175 | 111 |
| `portal/components/notifications/notifications-page.tsx:107` `NotificationsPage` | 505 | 86 |
| `portal/components/approval-inbox.tsx:252` `ApprovalInbox` | 464 | 53 |

### Duplicated blocks

```sh
npx jscpd@4 --min-tokens 70 --format javascript,typescript,tsx \
  --ignore "**/node_modules/**,**/*.test.mjs,**/*.test.ts,**/*.spec.ts,**/coverage-fixtures/**,**/.next/**" \
  engine cli tools status portal
```

Excluding tests, it found 261 clones covering 2,568 of 189,330 lines (1.36%). Nearly all of them
are in `.mjs` files (1.78%); `.ts` is at 0.25% and `.tsx` at 0.6%. The largest pairs are the same
collection or restore shape written out once per workload:

| Lines | Pair |
|---|---|
| 66 | `engine/collect/workloads/mailFlow.mjs` and `teamsPolicies.mjs` |
| 60 | `engine/collect/workloads/exchangeExtended.mjs` and `mailFlow.mjs` |
| 56 | `engine/restore/workloads/sharepointSiteGrants.mjs` and `sharepointSitePermissions.mjs` |
| 51 | `engine/restore/workloads/purview.mjs` and `teams.mjs` |
| 49 | `tools/qualification/sharepointSiteGrantsLive.mjs` and `sharepointSitePermissionsLive.mjs` |
| 47 | `engine/restore/workloads/dscDistributionGroups.mjs` and `sharepointStructure.mjs` |
| 44 | `engine/collect/workloads/exchangeExtended.mjs` and `teamsPolicies.mjs` |

### Dead code (knip)

`tools/code-health/node_modules/.bin/knip -c tools/code-health/knip.json` (run from the repository root)

- **Unused files:** two portal components that nothing imported, `components/ref-link.tsx` and
  `components/status-badge.tsx`. This PR deletes both. The menu has its own `StatusBadge`.
- **Unused exports:** 901. Unused exported types: 79. Most of these are helpers that are only used
  inside their own module, so they are exported for no reason. By area: `portal/lib` 249,
  `engine/restore` 154, `engine/collect` 126, `engine/content` 56, `engine/govern` 41,
  `portal/components` 39, `engine/benchmarks` 35.
- **Dependencies:** not checked. Each package keeps its own small dependency list, so knip's
  dependency check is switched off.

### Lint findings

These are the counts frozen in the baseline:

| Rule | Count | Note |
|---|---|---|
| `no-unused-vars` / `@typescript-eslint/no-unused-vars` | 114 + 13 | Dead locals and imports |
| `react-hooks/*` (React Compiler rules) | 96 | 35 preserve-manual-memoization, 17 set-state-in-effect, 16 error-boundaries, 11 exhaustive-deps, 9 use-memo, 6 refs, 2 immutability |
| `@typescript-eslint/no-floating-promises` | 16 | 13 are `main()` at the bottom of a CLI or tool script, 2 are portal fetch chains with no final catch, and 1 is in a test |
| `no-control-regex` | 11 | Deliberate control-character filters. Disable these with a reason |
| `no-dupe-keys` | 5 | 4 in `engine/restore/recordWriter.mjs` (see backlog item 3). The fifth was a duplicate `approvedContentEffects` in `cli/keel-restore.mjs`, removed in this PR |
| other | 8 | `no-useless-escape` 2, `no-extra-boolean-cast` 2, `no-fallthrough` 1 (intentional, `tools/tenant-probe/references.mjs:215`), `no-regex-spaces` 1, two `@next/next` |

`eqeqeq` found nothing outside the `== null` idiom.

### Modules no test imports

`node tools/code-health/measure.mjs untested` reads static imports and the portal's `@/` imports.
It also counts a test as reaching a CLI entry point when the test spawns it by file name, and
counts the UI harness page as a test.

Of 939 modules, 123 are not imported directly by any test, and 6 are not reached by any test at
all. The 6 are `cli/keel-schedules-migrate.mjs`, the ESLint config, and the portal's
`error`, `loading` and `template` route files, which the Next build covers. The modules with no
direct test import are mostly portal components (96), and the UI harness renders those. Only
1 module in `engine/collect` and 0 in `engine/restore` lack a direct test.

### Test runtime by suite

Each engine-suite file was run on its own, 4 at a time, on Mulinux, a loaded 4-vCPU host. The
absolute times are inflated. The order is the useful signal. All 425 files passed. In CI the whole
step takes about 2 minutes at `--test-concurrency=4`.

```sh
cd engine && ../tools/engine-test-files.sh | xargs -P4 -n1 sh -c 's=$(date +%s.%N); node --test "$0" >/dev/null 2>&1; echo "$0 $(echo "$(date +%s.%N) - $s" | bc)"'
```

| Area | Seconds (sum of files) |
|---|---|
| `engine/roadmap` | 1530 |
| `engine/restore` | 192 |
| `engine/content` | 167 |
| `cli` | 164 |
| `engine/export` | 115 |
| `engine/govern` | 95 |
| `tools` | 85 |

The slowest files are `engine/roadmap/keel-recovery.test.mjs` (252 s), `engine/content/store.test.mjs` (145),
`engine/export/bundle.test.mjs` (115), `engine/restore/applyEngine.test.mjs` (92),
`engine/roadmap/exchange-config.test.mjs` (70), `engine/roadmap/onedrive-purview.test.mjs` (69) and
`engine/restore/updatePath.test.mjs` (46).

### Skipped and excluded tests

- `tools/engine-test-files.sh` EXCLUDED (4):
  - `engine/store/dumpManifest.test.mjs` needs `/opt/mimoun/backup.sh`, which only the host has.
  - `engine/roadmap/nist-benchmark-acceptance.test.mjs` and
    `engine/roadmap/scubagear-benchmark-acceptance.test.mjs` need the pinned catalogs under
    `/var/lib/keel/reference-data`.
  - `engine/roadmap/foundation.test.mjs` **fails today** with a null revision lookup and has never
    run in CI.
- `portal/ui-harness/ui.spec.ts:2665` skips the pages listed in `CONTRACT_PENDING` until
  task-130/131. This is the only `skip` in the suites.
- Environment note: the engine suite fails locally when `TMPDIR` is inside another git repository.
  `engine/roadmap/recovery-set.test.mjs` then resolves the parent repository's revision. Cloud
  runners are not affected.

### Recurring CI failures (Portal workflow, 2026-10-22 to 2026-11-04)

```sh
gh run list --workflow portal.yml --limit 1000 --created ">=2026-10-21" --json databaseId,conclusion,headBranch,createdAt
gh run view <id> --json jobs     # which job and step failed
gh run view <id> --log-failed    # "location:" lines name the failing test file
```

There were 1,000 runs: 90 failed and 135 were cancelled. On master, 15 of 347 runs failed.

Failures by step:

| Step | Failed runs |
|---|---|
| Run restore engine tests | 58 |
| Accessibility, screenshot and interaction checks (Playwright) | 20 |
| Run portal tests | 13 |
| Typecheck | 2 |

Test files that failed in more than one run:

| Test file | Runs |
|---|---|
| `portal/test/record-glossary.test.ts` | 11 |
| `engine/roadmap/baseline-compliance-ui.test.mjs` | 11 |
| `engine/roadmap/entra-live-gate.test.mjs` | 9 |
| `engine/roadmap/acceptance-harness.test.mjs` | 9 |
| `engine/roadmap/visual-drift.test.mjs` | 8 |
| `engine/roadmap/drill-live-acceptance.test.mjs` | 8 |
| `engine/govern/evidence-known-break.test.mjs` | 8 |
| `engine/restore/wholeReplaceTrust.test.mjs` | 4 |
| `engine/govern/restoreApprovalsOff.test.mjs` | 4 |
| `engine/govern/restoreApprovalSettings.test.mjs` | 3 |

Most of these runs are on PR branches, where a failing check is doing its job. The roadmap tests
check that portal pages and docs match, so they break whenever a page changes. They fail more
than any other group, which makes them the best candidates for clearer failure messages (backlog
item 12). Three logs could not be read. The 19 failed runs with no `location:` line were
Playwright or typecheck failures.

## Cleanup backlog

Each item below fits in one PR and changes no behaviour. Restore and collector safety come first.
Lower the ratchet baseline in the same PR as the fix.

1. **Split `runRestore` into phases.**
   - Where: `cli/keel-restore.mjs:341`, 1,006 lines with complexity 416.
   - What: extract the phases (load and verify the plan, guards, apply, compensation, report) as
     named functions in the same file. The compensation block is the first and smallest step.
   - Why: this is the riskiest function in the product. Nobody can review a change to it in one
     reading.
   - Risk: medium. It is a pure move with no logic edits, and each phase should be its own PR.
   - Guarded by: `cli/keel-restore*.test.mjs` (5 files) and `engine/roadmap/keel-recovery.test.mjs`.
2. **Name the per-operation steps in `applyWave`.**
   - Where: `engine/restore/applyEngine.mjs:535`, a 668-line callback with complexity 311.
   - What: extract the refusal checks, the write, the read-back and journal steps into named
     functions.
   - Why: it is the second-biggest restore hotspot, and the trust and sign-in refusals are buried
     in it.
   - Risk: medium.
   - Guarded by: `engine/restore/applyEngine.test.mjs`, `updatePath.test.mjs`,
     `namedLocationTrust.test.mjs` and `wholeReplaceTrust.test.mjs`.
3. **Settle the duplicate keys in `defineRecordWriter`.**
   - Where: `engine/restore/recordWriter.mjs:132-164`. `excluded`, `createOnly`, `writable` and
     `checkedAfterWrite` are set as defaults and then always overwritten after `...spec`.
   - What: keep one definition of each. First check whether anything depends on property order
     (snapshots, hashing), because the early keys fix the order.
   - Why: a reader can't tell which value wins, and these are the restore writers' safety fields.
   - Risk: low.
   - Guarded by: `engine/restore/recordWriterTrust.test.mjs` and `intuneExtended.test.mjs`.
4. **Await `main()` in CLI and tool scripts.**
   - Where: `cli/keel-{baseline-create,collect,export,import,notify,plan,remediate,restore}.mjs`
     and `tools/qualification/{apiDrift,entraLive,nativeRecovery,operations,storageLiveAcceptance}.mjs`.
   - What: change `main();` to `await main();`, or to `main().catch(fail)` where the script needs
     a specific exit code.
   - Why: today a rejection becomes an unhandled-rejection crash. It still exits non-zero, but it
     skips each script's own error formatting.
   - Risk: low.
   - Guarded by: the CLI tests that spawn these scripts and check exit codes, such as
     `keel-restore-argv` and `keel-worker`.
5. **Pull the shared restore-writer plan helpers out of the workload writers.**
   - Where: these jscpd pairs: `sharepointSiteGrants` and `sharepointSitePermissions` (56 lines),
     `purview` and `teams` (51), `dscDistributionGroups` and `sharepointStructure` (47), all in
     `engine/restore/workloads/`.
   - Why: a safety fix made in one copy is easy to miss in the other.
   - Risk: medium.
   - Guarded by: `engine/roadmap/workload-writers.test.mjs` and each writer's tests.
6. **Pull out the shared collector shape.**
   - Where: `engine/collect/workloads/{mailFlow,teamsPolicies,exchangeExtended,purviewRetentionDlp}.mjs`
     (40 to 66 duplicated lines per pair).
   - What: one helper for the cmdlet batch and normalise step.
   - Risk: low to medium.
   - Guarded by: the collect workload tests and `engine/roadmap/exchange-*.test.mjs`.
7. **Split `engine/restore/intuneOperations.mjs`.**
   - Where: 2,902 lines.
   - What: one file per Intune area, with the current module re-exporting them, so that no import
     changes.
   - Why: it is the largest product file, and it is at its size budget.
   - Risk: low. It is a mechanical move, one area per PR.
   - Guarded by: `engine/restore/intuneExtended.test.mjs`.
8. **Fix `engine/roadmap/foundation.test.mjs` and remove it from EXCLUDED.**
   - What: it fails with a null revision lookup and has never run in CI.
   - Why: an excluded test protects nothing.
   - Risk: none to the product.
9. **Stop exporting module-private helpers.**
   - Where: 901 unused exports, starting with `engine/restore` (154) and `engine/collect` (126),
     then `portal/lib` (249).
   - What: remove the `export` keyword. Don't delete the helpers.
   - Why: a smaller public surface makes the real entry points visible.
   - Risk: very low. Do one folder per PR; the knip baseline drops with each.
   - Guarded by: the typecheck and the full suites.
10. **Remove dead locals and imports.**
    - Where: 127 `no-unused-vars` findings. The largest groups are in `tools/qualification` and
      `engine/roadmap` tests.
    - Risk: very low.
11. **Add a final catch to the portal's fire-and-forget fetches.**
    - Where: `portal/components/compliance/exception-sheet.tsx:48` and
      `portal/components/policies/new-rule-sheet.tsx:76`.
    - Risk: very low.
    - Guarded by: `npm run test:ui`.
12. **Make the most-failing roadmap tests say what to change.**
    - Where: `engine/roadmap/baseline-compliance-ui`, `acceptance-harness`, `entra-live-gate`,
      `visual-drift`, `drill-live-acceptance` and `portal/test/record-glossary.test.ts`, which
      failed in 8 to 11 runs each over two weeks.
    - What: make each assertion's message name the doc or page line to update.
    - Why: PR authors lose the most time to these tests.
    - Risk: none to the product.
13. **Speed up the slowest engine tests.**
    - Where: `engine/roadmap/keel-recovery.test.mjs`, `engine/content/store.test.mjs`,
      `engine/export/bundle.test.mjs` and `engine/restore/applyEngine.test.mjs`.
    - What: inject a zero-delay sleep where the read-after-write retry waits are what take the time.
    - Why: a shorter CI run means faster merges.
    - Risk: none to the product.
14. **Work through the React Compiler hook findings, one page per PR.**
    - Where: 96 findings, starting with the 17 `set-state-in-effect` (extra renders) and the 11
      `exhaustive-deps` (stale values).
    - Risk: medium, because rendering changes.
    - Guarded by: `npm run test:ui` screenshots.
15. **Split `portal/ui-harness/ui.spec.ts` and `app.tsx`.**
    - Where: 6,513 and 3,442 lines.
    - What: one spec file and one fixture module per page group.
    - Risk: none to the product. CI may get faster through Playwright's per-file parallelism.
