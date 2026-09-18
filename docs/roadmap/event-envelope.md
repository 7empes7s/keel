# Correlated operational and evidence events (task-77)

Implemented and fixture-tested only. No live qualification is claimed.

`engine/telemetry/events.mjs` projects evidence, job and drift rows into a
version-1 envelope: tenant, deterministic SHA-256 event ID, source component
and instance, source record ID/sequence, observed and emitted instants,
correlation/causation, redacted bounded payload, and capture measurements.
Replay identity excludes emission time, instance and capture settings. Source
record identity and sequence distinguish records even when sensitive payload
fields are redacted. Job IDs remain the correlation identity across retries;
queue reads retain the database's full-precision start timestamp for attempt
identity. Observed timestamps retain the source instant at JavaScript Date
precision. No attempt counter or source sequence is invented for legacy jobs
or drift rows. Evidence sequences are retained, including gaps; a gap may
represent another tenant's allocation in the global evidence sequence, not
necessarily lost evidence. Gap inspection refuses mixed tenant/source streams
and bounds the expansion window to 100,000 positions.

Payload budgets default to 16 KiB, with a minimum of 128 bytes. Oversized
payloads become a digest/size stub; identity is computed before truncation.
Nested credential keys, bearer/JWT/private-key values and PostgreSQL credential
URLs are redacted. This is structured-field redaction, not a guarantee of finding
arbitrary unlabeled secrets in free text. Capture options allow only numeric
job/Graph observations (attempt, durationMs, graphRequests, graphRetries,
graphThrottles); no extra polling or Graph requests are introduced.

The queue emits claims. The worker emits running and terminal envelopes after
its existing authorization decisions and passes `KEEL_EVENT_CORRELATION_ID` to
its child. It no longer logs command arguments containing the database URL.
Evidence appends redact subjects before hashing, store correlation in the
reserved subject `_event` member, and emit the committed record's projection.
The existing evidence chain remains the sole audit authority. Log-sink failure
cannot roll back a committed record; operational logs are best effort and do
not constitute a second durable audit ledger. Drift projection consumes existing
rows without a new drift writer, database reader, HTTP route or UI. Existing
server-side authorization and single-managed-tenant boundaries remain intact;
legacy jobs without tenant metadata explicitly use `tenant:unscoped` rather
than claiming a known tenant. That sentinel must not authorize tenant access.

## Compatibility and limitations

No DDL migration is needed: the additional evidence metadata uses the existing
JSON subject and participates in the existing hash. Historical subjects/hashes
are never rewritten; historical evidence without correlation reads as its
tenant evidence stream. Historical unredacted data is sanitized in projections,
but its immutable stored contents are not retroactively altered. New subject
metadata is additive and existing evidence verification remains valid. Reader
functions project rows already obtained through existing authorized paths;
they do not grant database or export access. No capability registries change.

Task-45 observation/qualification contracts remain unchanged; an event is not
proof of Microsoft support, an atomic tenant snapshot, or live recovery. No
collector/restorer credential changes, Conditional Access enforcement, external
notifications, service restarts or tenant mutations were performed.

## Verification

`engine/roadmap/event-envelope.test.mjs` exercises production projections,
queue claim/reclaim, missing-requester refusal, and an authorized fixture child
that appends evidence in a database isolated by `dbTestHelper.mjs`. It checks
persisted correlation, chain verification, stable IDs, distinct source sequences,
legacy reads, redaction, payload caps and a successful worker terminal event.
Two further boundary tests close a prior coverage gap: one asserts `claimNext`
emits exactly one `job.claimed` event through the sink when it actually claims a
job and none when the queue is empty; the other asserts a throwing `eventSink`
in `appendEvidence` cannot roll back or hide the already-committed evidence row
(the record is still returned and the chain still verifies). A projection-level
boundary test pins replay identity at every seam without relying on wall-clock
timestamps: re-projecting the same job, evidence or drift row reproduces the
same event id (including through `emitJobEvent` and a capture sink), while rows
differing only in `attempt_count`, `event_started_at` or evidence `seq` produce
distinct event ids. The three required mutations (random replay ID, nested
authorization leak, collapsed source sequences) each fail the boundary tests at
both the envelope seam and the job/evidence projection seams, as do two further
derived mutations (identity depending on capture budget; removing the
`job.claimed` emission or the evidence append's log-isolation try/catch). All
mutations are restored.

Exact validation:

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/event-envelope.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```
