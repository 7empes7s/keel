# Release acceptance: journeys and qualification ledger

Status on 2026-10-04: **readiness PENDING.** All six fixture journeys pass. No live
acceptance gate is qualified. See `docs/roadmap/acceptance-harness.md` for what each
journey proves and what it does not.

## How to produce the ledger

```bash
# 1. Fixture journeys (isolated test database only; refuses KEEL_DB_URL)
node tools/release/journeys.mjs run --db-url "$KEEL_DB_TEST_URL" --out journeys.json --build "$(git rev-parse HEAD)"
# 2. Ledger over the checked-in live records in docs/release/qualifications/
KEEL_QUALIFICATION_HMAC_KEY=... node tools/release/qualification.mjs ledger \
  --fixture journeys.json --tenant <tenant ref> --build <capture commit> --out ledger.json
# Add --require-ready to exit nonzero unless the ledger is ready.
```

Without the runner key, tenant and build, a non-placeholder record is reported
`unverified`. It is never counted as qualified.

## Readiness rule

- **`ready`**: every journey passed, every live gate is `live-qualified` or an accepted
  gap, and no objective is open.
- **`blocked`**: a journey failed, or a live gate failed verification. The other
  results are still reported.
- **`pending`**: everything else. That covers a missing record, a pending placeholder,
  an unverifiable record, a missing journey result, and an objective gap.
- **Accepted gaps**: a gate descoped by operator decision (only 117 today) keeps its real
  status and is never counted as qualified. It is listed under `readiness.acceptedGaps`
  instead of holding readiness. If its record fails verification, it still blocks.

## Current ledger (fixture results kept apart from live acceptance)

**Fixture (`fixture-tested`, synthetic):** J1 to J6 all passed.

**Live acceptance:**

| Task | Gate | Status |
|---|---|---|
| 113 | `deployed-acceptance` | pending |
| 114 | `storage-live-acceptance` | pending (retention lock and immutability unqualified by decision) |
| 115 | `native-live-acceptance` | pending |
| 116 | `drill-live-acceptance` | pending |
| 117 | `sentinel-live-acceptance` | pending, accepted gap (descoped by operator decision 2026-10-04) |
| 118 | `servicenow-live-acceptance` | pending |
| 119 | `nist-benchmark-acceptance` | unverified (needs the runner key, tenant and build) |
| 120 | `sharepoint-live-acceptance` | pending |
| 121 | `teams-live-acceptance` | pending |
| 122 | `exchange-live-acceptance` | pending |
| 123 | `onedrive-purview-live-acceptance` | missing on this branch; pending once task-123's placeholder is merged in |

**Objectives** (the definitions are in `docs/release/objectives-source.md`):

- **Qualify when their live gates verify:** D1, D2, D4, D5, D6, G6 and G8.
- **Explicit gaps:** D3, D7, D8, D9, D10, G1-G5 and G7. Each has no live gate, or its own qualification says it is unproven. The ledger names the reason for each one.

How to capture each live gate is in `docs/roadmap/operator-gates.md`.
