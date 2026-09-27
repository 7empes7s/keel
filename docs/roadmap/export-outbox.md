# Durable SIEM event outbox and replay checkpoints (task-79)

Implemented and fixture-tested only. No live SIEM delivery is claimed; the real
Azure Monitor / webhook / CEF sink adapters land in tasks 80/81 and register under
`SIEM_ADAPTERS` in `cli/keel-worker.mjs`. Until then a configured destination whose
kind has no adapter drains as `no-adapter` with every event left pending — nothing
is dropped and nothing is falsely acknowledged.

## What was built

`engine/telemetry/outbox.mjs` adds a durable per-destination outbox on top of the
task-77 event envelopes, backed by three additive tenant-scoped tables in
`engine/store/schema.sql`:

- `siem_destination` — one row per configured sink (tenant, name, adapter kind,
  config, enabled/revoked state). Config carries credential *references* only;
  secret-shaped values (bearer tokens, JWTs, private keys, credentialed DSNs) are
  refused at registration.
- `siem_outbox_event` — one row per (destination, source event id), so a producer
  retry can never duplicate a delivery and a redelivery always carries the original
  task-77 event id. Each row tracks status (pending/delivering/acknowledged/
  quarantined), attempts, durable `next_attempt_at` backoff, and quarantine reason.
- `siem_replay_checkpoint` — per destination: the highest acknowledged outbox
  sequence, its event id, and any pending operator replay request.

Delivery semantics are **at-least-once**, stated explicitly in the exported
`RECEIVER_DEDUP_CONTRACT`: receivers must deduplicate on
`(tenantRef, destinationId, eventId)`; exactly-once physical ingestion is never
claimed. Acknowledgement and checkpoint advance commit in one transaction, so a
crash after remote acceptance but before the commit leaves the event pending and it
is redelivered under its original id. Uncertain acknowledgements and thrown adapter
errors reschedule with exponential backoff (5s base, 15m cap, durable in
`next_attempt_at`); attempts beyond the per-event cap quarantine the event with the
reason preserved. A poison event quarantines without blocking or erasing the events
behind it. Revoking a destination pauses delivery durably; resuming restarts it.
`requestReplay` (configuration capability) rewinds the durable cursor and re-delivers
acknowledged events at or after a sequence under their original ids; quarantined
events are not silently un-quarantined by a replay. `outboxStatus` (read capability)
reports per-status counts, the checkpoint, and delivery lag measured from the oldest
unacknowledged event's observed instant — all from durable tables, so a worker
restart loses neither cursor nor lag.

The worker (`cli/keel-worker.mjs`) drains due destinations between job polls through
the exported `drainSiemOutbox` seam and the `SIEM_ADAPTERS` registry; a drain failure
is logged redacted and never kills the worker, because the outbox itself is the
durable state. `drainDueDestinations` selects destinations that have due events OR a
pending operator replay request, so a replay over a fully acknowledged queue is still
applied by the periodic worker loop.

## Authorization and tenant scoping

Every mutating path (register, revoke, resume, replay) checks the `configuration`
capability server-side; every read path (`listDestinations`, `outboxStatus`) checks
`read`. All queries are qualified by `tenant_ref`; an envelope whose tenant does not
match the destination's tenant is refused, and a foreign-tenant destination id
resolves to "not found". The drain path runs as the worker service against durable,
already-authorized destination configuration — the same model the job queue uses.

## Compatibility and limitations

The migration is additive and idempotent (`CREATE TABLE IF NOT EXISTS`); no existing
table, evidence chain, queue behavior or authorization registry changes, and the
evidence table remains the sole audit authority — the outbox is an operational
delivery log, not audit. A fixture adapter proves only this code's behavior, not any
real SIEM's acceptance semantics, Microsoft support, or tenant delivery. No
collector/restorer credential changes, Conditional Access enforcement, live
notifications, service restarts or tenant mutations were performed.

## Verification

`engine/roadmap/export-outbox.test.mjs` exercises the production module against an
isolated `dbTestHelper.mjs` database with a recording fake sink: enqueue dedup and
checkpoint advance only after ack; uncertain acknowledgement replaying the same event
id (the crash-after-acceptance case); durable backoff and max-attempts quarantine;
poison quarantine that neither drops the event nor blocks its successors; revoke /
resume pausing; cursor and lag surviving a fresh connection; operator replay under
stable ids; cross-tenant refusal and capability checks on every path; no-adapter
visibility; secret refusal in destination config; the at-least-once receiver dedup
contract; and the worker's drain-failure isolation — `drainSiemOutbox` (the exact seam
`main()` calls between job polls) is driven with a failing client and must resolve,
log the failure redacted, and leave the durable outbox retryable on the next poll —
and the same worker entry point applying an operator-requested replay over a fully
acknowledged queue (no due events) under the original event ids.
The three required mutations (checkpoint advanced before acceptance, new event id on
retry, poison silently dropped) each fail these tests, as do derived mutations
(removing the drain-failure try/catch, skipping the authorization checks or the
tenant qualification).

Requeue verification adds boundary coverage for malformed adapter outcomes (no
acknowledgement or checkpoint advance, durable retry under the same ID), synthetic
JWT/PEM secret shapes nested in destination config (rejected before storage), and
worker replay over mixed acknowledged/quarantined events (the poison row remains
unchanged). The revoked-destination guard was already correct in the inspected
tree. All three required mutations, the three previously surviving mutations, and
disabling the revoked-destination guard were individually killed by these tests;
production source was restored byte-for-byte after each mutation. Validation uses
only injected sinks and isolated test database schemas.

Exact validation:

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/export-outbox.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```
