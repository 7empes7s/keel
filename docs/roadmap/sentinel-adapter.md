# Azure Monitor and Sentinel export adapter (task-80)

Implemented and fixture-tested only. **No live Sentinel/Azure Monitor ingestion is
claimed.** The adapter code is exercised end-to-end against the task-79 outbox with
an injected fake ingestion endpoint and fake token provider; live workspace
ingestion qualification is the externally evidenced gate task-117, which remains
held until the orchestrating session produces real runner evidence.

## What was built

`engine/telemetry/adapters/sentinel.mjs` implements the current Azure Monitor
Logs Ingestion API as a task-79 outbox adapter (destination kind
`azure-monitor-sentinel`):

- **Request shape** (checked against the official documentation during
  implementation, Global Constraint 8): `POST {endpoint}/dataCollectionRules/{DCR
  immutableId}/streams/{stream}?api-version=2023-01-01` with a UTF-8 JSON array
  body. The endpoint is the configured DCE or DCR logs ingestion endpoint and must
  be https. Source: <https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview>,
  retrieved 2026-09-26; limits: <https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/service-limits>.
- **Token audience** is `https://monitor.azure.com/.default` (`.cn` / `.us` for
  sovereign clouds), derived from a fixed cloud map — never free-text
  configuration, so the Graph audience is structurally impossible, not just
  discouraged. The sender credential is a *dedicated* Entra app registration
  (certificate client-credentials) referenced by the destination config as
  `credentialRef: 'env:<VAR>'`; it is neither the collector nor the restorer
  credential, and the read/write credential separation is untouched.
- **Event identity**: every record carries the deterministic task-77 KEEL event id
  (`KeelEventId`), the tenant (`TenantRef`), a tenant-specific source identity
  (`SourceIdentity = keel:<tenantRef>`) and the destination id. The per-request
  `x-ms-client-request-id` is diagnostic only — a fresh GUID per request,
  documented in code and ops artifacts as *not* an idempotency or dedup guarantee.
- **Outcome mapping** follows the task-79 adapter contract: 2xx → `accepted`; 429 →
  `retry` honouring `Retry-After` (a throttled batch is never acknowledged); 401/403
  (Monitoring Metrics Publisher role propagation is eventually consistent), 408 and
  5xx → `retry`; timeout/lost response → `uncertain` so the outbox redelivers under
  the SAME event id; 400 (stream schema rejected), other 4xx, an unmappable
  envelope or a cross-tenant envelope → `poison` (durable quarantine with reason).
- **No implicit provisioning**: workspace, custom table, DCE, DCR, app registration
  and role assignment must exist already. Missing endpoint, DCR immutable id,
  credential reference or an unsupported cloud are returned as *named pending setup
  prerequisites* (`sentinelSetupPrerequisites`); the event stays pending and no
  request is attempted.
- **No tokens in logs**: the token is used only in the Authorization header; every
  error string carries HTTP status and the service's `x-ms-request-id` diagnostic,
  never headers, bodies or token material. Token-acquisition failures are reported
  as a generic pending prerequisite.

Supporting artifacts:

- `ops/sentinel-schema.json` — operator-managed custom table `KeelEvents_CL` /
  stream `Custom-KeelEvents` declaration and DCR template skeleton, with the
  Constraint-8 documentation pin (URL, retrieval date, credential mode, limits).
  The boundary tests assert it matches the adapter's emitted columns exactly,
  including avoidance of the documented reserved column names (`TenantRef` and
  `EventType` are used instead of the reserved `TenantId` / `Type`).
- `ops/sentinel-dedup.kql` — the logical dedup view. Delivery is at-least-once
  (task-79 `RECEIVER_DEDUP_CONTRACT`), so the same event can be physically ingested
  more than once under the same `KeelEventId`; the view collapses duplicates with
  `arg_max(TimeGenerated, *) by TenantRef, DestinationId, KeelEventId`.
- `tools/qualification/sentinel.mjs` — offline, read-only setup check:
  `node tools/qualification/sentinel.mjs check --config <file> [--tenant <ref>]`
  validates a destination config against the named prerequisites and emits a
  task-45-shaped qualification ledger record. The record is always
  `evidenceLevel: 'fixture-tested'`, `synthetic: true` — this harness can never
  mint a live-qualified claim. It never provisions resources, calls a live
  endpoint, or touches the tenant.

The worker (`cli/keel-worker.mjs`) registers the adapter in `SIEM_ADAPTERS` under
`azure-monitor-sentinel`; the sender credential is resolved from the destination's
credential reference per delivery, so no secret is held in the registry.

## Authorization and tenant scoping

Destination management (register/revoke/resume/replay) remains behind the
task-79 `configuration` capability, reads behind `read`, all qualified by
`tenant_ref`; the drain path runs as the worker service against durable,
already-authorized configuration. The adapter itself refuses a cross-tenant
envelope as poison before any request. Conditional Access is untouched — nothing
here enforces or changes it.

## Compatibility and limitations

No schema or migration changes; the adapter reuses the task-79
`siem_destination`/`siem_outbox_event`/`siem_replay_checkpoint` tables. A fixture
endpoint proves only this code's behavior — not real Azure Monitor acceptance,
DCR semantics, or tenant delivery. The fixture KQL evaluation mirrors the shipped
view's semantics; the view itself runs in Sentinel, not here. No live
notifications, service restarts, cloud provisioning or tenant mutations were
performed.

## Verification

`engine/roadmap/sentinel-adapter.test.mjs` exercises the production adapter and
the production outbox drain against an isolated `dbTestHelper.mjs` database with
injected fake endpoint/token provider: URL/body/audience validation at the fixture
endpoint; per-cloud audience derivation with Graph structurally excluded;
429-throttle retry with `Retry-After` timing, no acknowledgement and checkpoint
pinned at 0, then redelivery under the same event id; timeout → uncertain → same-id
replay with per-request diagnostic request ids differing while the KEEL event id
stays stable; 400 poison quarantine; 401/403/408/5xx retry; missing DCR as named
pending setup with zero requests attempted; token material absent from outcomes,
errors, bodies and logs even with an adversarial token-echoing sink; KQL fixture
collapsing duplicated rows into one logical event while distinct events never
merge; ops schema/adapter column agreement; worker `SIEM_ADAPTERS` registration
routing through `drainDueDestinations`; cross-tenant poison refusal; and the
offline qualification tool's pass/fail exit codes with named prerequisites.

All three required mutations were individually applied and killed by these tests
(acknowledging a throttled batch; using the Graph token audience; treating
`x-ms-client-request-id` as the dedup identity), with production source restored
byte-for-byte after each.

Requeued task-80 validation (2026-09-26): restored the parked implementation
against current HEAD while preserving the existing webhook/CEF worker registrations.
Added direct mapping/delivery and isolated outbox fixtures for mismatched outbox
and envelope event ids. They require poison quarantine before token acquisition
or ingestion, preserve both stored identities, and prohibit acknowledgement or
checkpoint advancement. Matching ids and legacy callers omitting the separate id
remain supported. Removing the identity guard fails both new tests; the three
required mutations were also rerun and killed. Official API and limits sources
above were rechecked on this date; qualification remains fixture-only.

The default certificate flow currently uses the public-cloud Entra authority;
sovereign-cloud audience mapping and cache separation are fixture-tested, but
sovereign-cloud credential acquisition is not live-qualified.

Exact validation:

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/sentinel-adapter.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```
