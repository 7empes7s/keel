---
name: keel-generated-files
description: Use when you change a type's restore status, coverage text or operation count, or when a merge or rebase conflicts in docs/coverage.md, engine/coverage/qualification.mjs, the ledger test counts or ops/STATE.md.
---

# Generated files and ledger counts

Several restore PRs land each day, and they all touch the same few files. Conflicts there are normal.
Resolve them by **regenerating** or **adding up**, never by picking one side.

## The files

| File | Kind | How to update | What fails when it is wrong |
|---|---|---|---|
| `docs/coverage.md` | Generated | `node tools/coverage-doc.mjs` (repo root) | `engine/coverage/coverageDoc.test.mjs`, `node tools/coverage-doc.mjs --check` |
| `docs/roadmap/benchmark-content/scubagear-coverage.md` | Generated | `node tools/scubagear-rules.mjs report --write` | `engine/benchmarks/scubagear/import.test.mjs` |
| `docs/roadmap/release-signoff.md`, `docs/roadmap/operator-gates.md`, the generated section of `docs/release/acceptance.md` | Generated for one candidate build | `node tools/release/readiness.mjs …` (each file names its command) | leave them alone in a feature PR |
| `engine/coverage/qualification.mjs` | Hand-written ledger (`TYPE_DECISIONS`, `recordRemappingProof`, `EXPANSION_INVENTORY`) | edit by hand | `engine/roadmap/fidelity-ledger.test.mjs`, `fidelity-expansion.test.mjs` |
| `engine/coverage/coverageDoc.mjs` (`TYPE_GUIDE`) | Hand-written text that feeds `docs/coverage.md` | edit by hand, then regenerate | `coverageDoc.test.mjs` (a decision changed without its text) |
| `engine/coverage/completeness.mjs` | Hand-written | edit by hand | `engine/coverage/completeness.test.mjs` |
| `tools/qualification/operations.mjs` (`FIXTURE_PAYLOADS`, `fakeGraph`) and `tools/qualification/live-gate-plan.mjs` | Hand-written | edit by hand | `fidelity-ledger.test.mjs` (fixture harness), `engine/roadmap/entra-live-gate.test.mjs`, `tools/qualification/live-gate-plan.test.mjs` |
| `engine/roadmap/fidelity-ledger.test.mjs` | A test that pins counts (`supported.length`, `results.length`) | recompute (below) | itself |
| `ops/STATE.md` "Open live gates" | Hand-written list | keep every line | review |

Never edit `docs/coverage.md` by hand. Its header says so, and the test compares it byte for byte with
`renderCoverageDoc()` from `engine/coverage/coverageDoc.mjs`.

## After changing a type's status

1. Edit `TYPE_DECISIONS` and the `EXPANSION_INVENTORY` entry in `engine/coverage/qualification.mjs`.
2. Update that type's `TYPE_GUIDE` entry in `engine/coverage/coverageDoc.mjs` so the text matches the new decision.
3. Regenerate: `node tools/coverage-doc.mjs`, then `node tools/coverage-doc.mjs --check`.
4. Recompute the pinned count (below) and update the two asserts plus the long message in
   `engine/roadmap/fidelity-ledger.test.mjs`. Add your issue to the end of the message the way the others are
   written (`issue #NNN: … (n)`).
5. Run the ledger tests:
   ```bash
   cd engine && node --test coverage/coverageDoc.test.mjs coverage/completeness.test.mjs \
     roadmap/fidelity-ledger.test.mjs roadmap/fidelity-expansion.test.mjs roadmap/capability-registry.test.mjs \
     roadmap/entra-live-gate.test.mjs
   ```

### Recompute the supported-operation count

```bash
cd engine && node -e "import('./coverage/qualification.mjs').then(m => console.log(
  m.buildOperationLedger().types.flatMap(r => r.operations).filter(o => o.decision === 'supported').length))"
```

## Resolving a conflict

First bring in master: `git fetch origin && git merge origin/master`. Never force-push.

- **`docs/coverage.md`**: do not resolve its hunks. Resolve every *source* file first, then run
  `git checkout --theirs docs/coverage.md && node tools/coverage-doc.mjs && git add docs/coverage.md`. The file
  is a pure function of the code, so regenerating it is the whole resolution.
- **`engine/coverage/qualification.mjs`**: keep **both** sides. Each PR adds or changes different keys in
  `TYPE_DECISIONS` and `EXPANSION_INVENTORY`, and each adds its own `recordRemappingProof(...)` line. If both
  sides changed the **same** key, combine the two subset texts so that each PR's claim is still true, and say
  so in the PR.
- **`engine/coverage/coverageDoc.mjs`, `completeness.mjs`, `tools/qualification/operations.mjs`,
  `live-gate-plan.mjs`, `engine/safety/contentEffects.mjs`**: keep both sides. They are keyed maps, so a
  conflict is usually two neighbouring entries.
- **`engine/roadmap/fidelity-ledger.test.mjs`**: never take one side's number. Recompute it (above) after the
  source files are merged. Keep both issues' parts of the message. Check that the number equals master's count
  plus what your branch adds.
- **`ops/STATE.md`**: keep both sides' lines and update **Last updated**.

Then run the ledger tests above, plus anything else your PR touched. A conflict resolution goes in the merge
commit; do not add separate "fix count" commits.

## Common mistakes

- Taking `--ours` on `fidelity-ledger.test.mjs`: master's new operations disappear from the count, and CI fails
  on the next PR.
- Regenerating `docs/coverage.md` before the source conflicts are resolved: the output still has conflict
  markers in it, or misses one side's types.
- Changing `TYPE_DECISIONS` without its `TYPE_GUIDE` text: `coverageDoc.test.mjs` fails with
  "written for 'X', now says 'Y'".
