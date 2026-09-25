# Generic webhook and CEF export adapters (task-81)

Implemented and fixture-tested only. No live SIEM/syslog delivery is claimed: every
test drives the production adapters against injected fake transports (`fetchImpl`,
`sendUdp`) or a bounded loopback UDP socket, never a real external endpoint. The
Azure Monitor / Sentinel adapter (task-80) is a separate, independently registered
sink under the same `SIEM_ADAPTERS` map and is out of scope here.

## What was built

`engine/telemetry/adapters/webhook.mjs` — the reference generic transport for the
task-79 outbox. One task-77 envelope becomes one authenticated `POST`:

- **Routing is destination-only.** The URL comes exclusively from the registered
  `siem_destination.config.url` — never from the event payload — so an event can
  never choose or redirect its own delivery target. `https` is required; plain
  `http` is accepted for loopback hosts only, which keeps bounded local fixtures
  possible without opening a plaintext path to a remote sink.
- **Authentication** resolves credential *references* through an injected resolver
  (`bearer` via `Authorization: Bearer <token>`, `hmac-sha256` via a signed
  `x-keel-signature` header); the default resolver understands only `env:NAME`
  references and never invents a credential — an unresolved reference is a visible
  retry, not a silent unauthenticated send.
- **Identity.** The stable task-77 `eventId` and the outbox's `(tenantRef,
  destinationId, eventId)` dedup key travel as `x-keel-event-id` /
  `x-keel-dedup-key` headers on every attempt, including retries; a retry never
  mints a new id, so a repeated event keeps its id end to end.
- **Outcome honesty.** 2xx is `accepted`; 408/429/5xx is a bounded `retry`
  (`Retry-After` honoured, capped); any other 4xx is `poison` (redelivering
  identical bytes will not change a receiver's rejection); a timeout/abort *after*
  the request was sent is `uncertain` — the receiver may have accepted, so the
  event is redelivered under the same id rather than reported delivered.
  `x-ms-client-request-id`-style request ids are diagnostic only, never treated as
  an idempotency guarantee.

`engine/telemetry/adapters/cef.mjs` — a bounded, escaped Common Event Format sink.
One envelope becomes one single-line CEF record:

- **Injection safety.** CEF header fields escape `\` and `|`; extension values
  escape `\`, `=`, CR and LF; the finished record is asserted single-line before it
  is ever sent. Producer-controlled fields that reach the record (event type,
  source component, causation id) can carry arbitrary bytes and still cannot break
  framing or forge a second record/extension pair. The raw payload is never
  embedded — only its sha256 digest and byte size — so payload content cannot
  influence record size or shape at all.
- **Bounded.** A record exceeding `maxMessageBytes` (default 4096, destination
  configurable, minimum 256) is never truncated into a misleading record; that
  event is poisoned for this sink with the size reason, and the outbox quarantines
  it visibly.
- **Acknowledgement honesty.** The destination config *declares* the transport's
  delivery guarantee. `acknowledgement: 'none'` (UDP syslog, or an HTTPS receiver
  that only confirms the transport handshake) means a successful send says nothing
  about remote acceptance: the outcome is `uncertain`, never `accepted`, and the
  event is redelivered under its original id. Only `acknowledgement:
  'http-response'` over the `https` transport turns a 2xx into `accepted`. A `udp`
  destination declaring `http-response` fails visibly at delivery time instead of
  silently upgrading the guarantee.

`cli/keel-worker.mjs` registers both adapters with production defaults (global
`fetch`, `node:dgram`, `env:` credential references) under the `webhook` and `cef`
keys of the existing `SIEM_ADAPTERS` map that `drainDueDestinations` already
dispatches on (task-79); no drain-path code changed.

### Portal integration

`portal/app/integrations/page.tsx` (nav: Integrations) lists the tenant's `webhook`
and `cef` destinations with live status (pending/delivering/acknowledged/quarantined
counts and delivery lag) via `GET /api/integrations`, and lets an operator drill into
a destination's quarantined events (`GET /api/integrations/[id]/quarantined`) to see
setup and errors (the quarantine reason). Registering a destination, pausing/resuming
it, and requesting a replay (`POST /api/integrations`, `.../[id]/revoke`,
`.../[id]/resume`, `.../[id]/replay`) require the `configuration` capability, checked
both by the portal's `guarded()` wrapper and again inside
`engine/telemetry/outbox.mjs` itself. Viewing the page and destination status
requires only the `read` capability, so a read-only viewer can see setup, lag, errors
and quarantined events but the console renders no configure/replay controls for them,
and the underlying routes independently refuse the attempt if one is forced.

## Authorization and tenant scoping

Every mutating portal route resolves to `engine/telemetry/outbox.mjs`'s existing
`registerDestination` / `revokeDestination` / `resumeDestination` / `requestReplay`,
which already check the `configuration` capability and qualify every query by
`tenant_ref` (task-79); this task adds no new authorization surface, only two new
adapter implementations and their registration. `listDestinations` /
`outboxStatus` (both `read`) are reused unchanged for the read paths.

## Compatibility and limitations

No schema changes: `siem_destination.kind` was already a free-text column: this
task adds the `webhook` and `cef` values via the existing `registerDestination`
path, nothing new to migrate. A fake fixture transport or a bounded loopback UDP
send proves only this code's behavior, never a real receiver's acceptance
semantics or any external product's actual support. No collector/restorer
credential changes, Conditional Access enforcement, live tenant mutation, live
notification, service restart, or cloud resource provisioning were performed.

## Verification

`engine/roadmap/generic-siem.test.mjs` exercises the production adapters and their
outbox/worker wiring: CEF field escaping and end-to-end single-line/no-forged-record
behavior against producer-controlled fields carrying CEF metacharacters; an oversized
record poisoned with its size reason; webhook/CEF routing driven only by the
registered destination config even when the event payload carries a competing
URL/host/port; UDP `acknowledgement: 'none'` deliveries that always send but never
report `accepted`; a `udp` + `http-response` contradiction refused before sending;
`https` acknowledgement honesty (`none` stays `uncertain`, `http-response` on 2xx is
`accepted`); webhook outcome classification (2xx/408/429/5xx/other-4xx) with
`Retry-After` propagation; timeout-after-send reported `uncertain`; bearer/hmac auth
header construction with no secret leakage into the request body or an error
message; an unresolved credential reference refused as a visible retry before any
request is sent; a full outbox retry cycle (503 then 200) proving the same event id
and dedup key travel on both attempts and the checkpoint advances only on the
second, accepted attempt; a read-only viewer refused both `registerDestination` and
`requestReplay` while retaining `outboxStatus` read access; and the real
`SIEM_ADAPTERS` registration from `cli/keel-worker.mjs` driven through
`drainDueDestinations` for both a webhook (fake global `fetch`) and a CEF UDP
destination (a real, bounded loopback socket) to prove the wiring itself, not just
the adapter functions in isolation.

The three required mutations — interpolating an unescaped CEF newline, routing a
webhook/CEF delivery using the event payload's URL instead of the registered
destination config, and reporting an unacknowledged syslog delivery as `accepted`
— each fail this suite; production source was restored byte-for-byte after each
mutation during review.

Exact validation:

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/generic-siem.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```
