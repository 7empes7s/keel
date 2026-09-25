# Bounded audit and sign-in ingestion (task 88)

Implemented at current HEAD using task 47's distinct empty/failed/partial outcomes
and task 77's canonical event envelope. This is optional and disabled unless
`enabled: true`. No standing queue job, timer, tenant permission, Microsoft writer
or Conditional Access enforcement was added. Collector/restorer credentials remain
separate; ingestion accepts only a tenant-bound `collector-read-only` adapter.

## Worker and CLI contract

`runAuditIngestion(client, options)` in `cli/keel-worker.mjs` is the bounded worker
entry. `runAuditCommand` is the one-shot CLI's production seam. Normal worker job
polling is unchanged. The task names no portal surface; evidence is available
through the authorized server reader and the CLI report, without adding a portal
gate or changing another workstream.

Run an explicit additive local migration with `keel-worker.mjs --audit-migrate`.
`--audit-config FILE` performs one bounded run and exits without starting the job
queue; `--audit-config FILE --audit-report` returns authorized evidence. Existing
`--db-url`/`KEEL_DB_URL` selects the database. During builder verification only
`engine/test/dbTestHelper.mjs` isolated schemas are used. No production migration
or live rehearsal was executed by the builder.

The trusted operator configuration contains `managedTenantRef`, `tenantRef`,
`requestedBy` (an existing principal ID), `source` (`audit` or `sign-in`), `enabled`,
`from`, `until`, and optional budgets/cost inputs. Managed tenant and principal
identity must come from trusted server/configuration context, never request-body
identity claims. Both tenants must match. The existing `can` capability check
runs at entry, before each page, before page persistence, and before evidence
writes; reports require current `read`, ingestion requires current `collect`.
A disabled principal or revoked grant cannot persist the fetched page.

The CLI supports either `fixturePages` (synthetic local fixtures) or an
`archiveRef`, such as `archive:organization-audit-2026`. An archive reference is an
opaque safe identifier, not a URL with query parameters, signed URL, credential,
or copied archive payload. Reference-only mode records no event rows and makes
no archive-completeness claim. The server worker seam additionally accepts an
injected adapter. No arbitrary module loader or restorer configuration is used.

## Read-only adapter and storage contract

`readPage({source, from, until, cursor, limit, signal})` returns
`{events: [{id, occurredAt}], nextCursor, availableFrom?}`. `nextCursor` is a stable,
monotonically increasing safe integer offset in an immutable bounded source
window, or null for completion. A new window begins with a null cursor. An adapter
must honor the limit, abort signal and window, and must translate source errors
into numeric HTTP-like `status` values. A 401/403 produces `read-scope-revoked`,
other failures produce `read-failed`; raw error text is never retained.

The included `createFixtureAuditAdapter` is **fixture-tested**, synthetic and
network-free. No Microsoft Graph endpoint implementation or live qualification
is claimed: Graph continuation tokens cannot be persisted as these integer
cursors. A real provider must implement this stable-window contract and be
independently qualified before use. No unstable external vendor API was added
or used; there is therefore no fabricated vendor capability/qualification ledger.
An existing organizational archive may be referenced immediately without a full
duplicate ingest.

Three tenant-scoped tables hold source state, minimized events and bounded-run
evidence. Migration uses `CREATE ... IF NOT EXISTS` and additive `ADD COLUMN IF
NOT EXISTS`; it is repeatable and preserves existing rows. The reader returns
`not-configured` with an unknown count if the tables are absent, not a fabricated
successful empty log. No legacy audit ingestion tables existed at inspected HEAD.

Only source event ID and event timestamp are retained. Nested payloads, tokens,
IP addresses, UPNs, display names, arbitrary strings and continuation URLs are
not persisted. IDs/references are length/character bounded and token-shaped
values are refused. Deduplication uses `(tenant_ref, source, source_event_id)`.
Source checkpoints and the whole minimized page are committed in one transaction;
a failed insert cannot advance the cursor. A per-tenant/source advisory lock
prevents two workers from racing checkpoints. Resume uses the saved window and
refuses a changed upper bound until that window is complete.

## Limits and evidence

Defaults: 10 page requests, 1,000 observed events, 100 events/page, 30 seconds,
30 retention days. Hard maxima: 100 requests, 10,000 events, 1,000 events/page,
60 seconds, 90 retention days, 90-day source windows. No retries occur inside a
request. A timeout aborts and stops awaiting the adapter; adapters remain
responsible for stopping their own I/O when signalled. Database transaction
latency is not a hard real-time guarantee. Duplicate events consume the work
budget. Invalid/oversized pages do not advance state. A nonterminal page stream
ends as `budget-exhausted`, preserving the committed cursor for restart.

Event retention is relative to the requested observation window's upper bound;
run evidence retention is relative to database time. The latest source retention
gap survives in source state even when older run evidence expires. Gaps reported
by `availableFrom` are visible separately from successful page traversal; absent
source retention information is unknown, not proof of complete historical logs.
Reports return at most 100 recent runs plus persistent source state and event
count. Expiration is performed during authorized ingestion, not by a new timer.
Stable-ID deduplication applies within retained history.

Each run records running/terminal transitions, the fixed observation window,
request count, observed event volume, newly stored minimized bytes, and any lost
retention window. Each committed page updates running evidence. The task 77
envelope correlates state to the local run; this is an operational projection,
not a replacement for the governance evidence chain. A crash may leave a run
marked running; the next invocation resumes its source checkpoint and creates
a new run, never retroactively marking the abandoned run successful.

Sizing labels fixture measurements `synthetic: true`. `costInputs` accepts only
nonnegative numeric `perRequest` and `perGiBMonth`; omitted prices yield unknown
costs. These estimates exclude database indexes, replicas, provider licensing,
and existing archive charges. No tenant-wide volume or atomic snapshot is claimed.

## Verification

`engine/roadmap/audit-ingestion.test.mjs` drives the production worker, CLI seam,
reader, migration and PostgreSQL persistence with injected local fixtures. It
covers restart/overlap deduplication, insertion failure, visible retention gaps,
revoked read scope versus empty logs, current authorization, tenant and credential
separation, event/request/time limits, secret minimization, independent sign-in
state, retention pruning, archive references and pre-migration reads.

Required mutations were executed and restored:

- Cursor update moved before the persistence transaction: failed the persistence
  failure/cursor boundary test (8 passed, 1 failed at mutation run).
- Retention gap omitted from run evidence: failed the retention gap boundary test
  (8 passed, 1 failed).
- Request-budget condition removed: failed restart and infinite-stream tests
  (7 passed, 2 failed).

Additional review found and fixed resumption of a partially ingested subsequent
window using the original configured lower bound; a dedicated regression test
covers it. Rolled-back pages restore evidence counters so failed writes cannot
claim committed events. Live Microsoft support, permissions, retention availability
and cost inputs remain unqualified. No live tenant writes or service restarts
were performed.

Exact roadmap validation (from `/opt/keel`):

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/audit-ingestion.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```
