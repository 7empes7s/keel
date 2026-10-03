# Teams, Slack, PagerDuty and SMS channel adapters (task 84)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only. Nothing was sent to a
real provider.

## What was built

### Provider contracts (`engine/notify/channels/*.mjs`)

Each provider is a small, pure contract with three parts:
- `validateConfig`, which lists the problems in a stored channel config;
- `prepare`, which builds the request or says why the channel is unconfigured;
- `interpret`, which turns the HTTP reply into an outcome and a receipt.

| Kind | Endpoint | Stored config | Success | What "delivered" means |
| --- | --- | --- | --- | --- |
| `teams` | Teams Workflows webhook (`*.logic.azure.com`, `*.environment.api.powerplatform.com`) | `endpointRef` | 200 or 202 | The workflow accepted the request. KEEL is not told whether the flow then posted. |
| `slack` | Slack incoming webhook (`https://hooks.slack.com/services/...`) | `endpointRef` | 200 `ok` | Slack posted it to the webhook's channel. |
| `pagerduty` | Events API v2 `/v2/enqueue`, US or EU region | `routingKeyRef`, `region` | 202 | PagerDuty accepted the event. Events with the same dedup key join one incident. |
| `sms` | Twilio Messages API | `provider: "twilio"`, `accountSid`, `authTokenRef`, `from` or `messagingServiceSid`, `to` | 201 | Twilio queued the text. Delivery to the phone is not tracked. |

### Shared rules (`engine/notify/adapters.mjs`)

- **Credential references only.**
  - Webhook addresses, the PagerDuty routing key and the Twilio auth token are stored
    as `env:NAME` references. A webhook address counts as a secret, because its path
    is the credential.
  - `createChannel` refuses a raw value, an unknown setting, or an unsupported provider
    or region.
  - The default resolver reads the worker's environment at send time. Tests inject one.
- **Four outcomes.**
  - `delivered`.
  - `retry`: 408, 429, 5xx, or a request that did not complete.
  - `rejected`: any other 4xx. The provider refused this request, and sending it again
    will not help.
  - `unconfigured`: a missing credential, an unsupported endpoint or an unsupported
    provider. Nothing is sent.
- **Retry-After.** It is read as delta-seconds or as an HTTP date, converted to
  milliseconds, and capped at one hour.
- **Payload caps.**
  - Teams: card text 1,000 characters; each fact 200.
  - Slack: text 3,000 characters, with `&`, `<` and `>` escaped.
  - PagerDuty: summary 1,024; `source`, `component`, `group` and `class` 255;
    `custom_details` 16 KB.
  - SMS: body 320 characters, which is two segments.
- **Redaction.**
  - Every resolved secret is replaced with `[redacted]` in error messages and receipts
    before anything is recorded. That covers the raw value, the normalized URL, the
    Teams signature query, the Slack path and the Twilio Basic header.
  - A provider that echoes the request back, or a network error that names the address,
    still leaves nothing secret in the log.

### PagerDuty dedup

- The `dedup_key` for an alert event is `keel:alert:<alertId>:<occurrence>`. Any other
  event uses `keel:delivery:<deliveryId>`. A key longer than 255 characters is replaced
  by a hashed form.
- The attempt number is never part of the key. A retried send therefore lands on the
  same incident, and so does the task-83 escalation of the same occurrence.

### Delivery integration (`engine/notify/notifications.mjs`)

- The channel kinds widen to `webhook`, `email`, `teams`, `slack`, `pagerduty` and
  `sms`.
- The adapter transports join `DEFAULT_TRANSPORTS`. Transports now also receive the
  delivery.
- `attemptDelivery` acts on the adapter's outcome:
  - `unconfigured` cancels the delivery with an actionable reason. No retry job is
    queued.
  - `rejected` fails it at once, even when attempts remain.
  - `retry` schedules the next attempt at the provider's Retry-After when one was given,
    and at the existing backoff otherwise. The delivery row and its follow-up notify job
    both carry that time.
  - Every outcome stores the redacted receipt in `delivery.provider_receipt`. The
    receipt holds the outcome, the HTTP status, the endpoint host, the dedup key or
    provider message id, the provider status and what "delivered" means for that
    provider.
- The webhook and email transports behave as before.

### Portal

- **Settings › Notifications** can add each new kind with labelled fields.
  - The forms ask for the name of the server setting that holds the secret, never the
    secret itself.
  - SMS offers Twilio as the only provider.
- Each channel says what it does, naming the server setting rather than its value.
- Delivered alerts say what "delivered" means for their provider. The provider's reply
  appears in the record.
- A refused channel kind or config now comes back as a 400 that carries the engine's
  message.

## Migration and legacy reads

- `channel_kind_check` is dropped and re-added with the wider list. Existing rows are
  untouched.
- `delivery.provider_receipt jsonb` is a new nullable column. Older deliveries read as
  null, and the portal shows nothing extra for them.
- A row written by hand with an unsupported provider is cancelled as unconfigured at
  send time, and nothing is sent. The boundary tests include this case.

## Limitations

- **The vendor contracts could not be re-verified when this was implemented.**
  - The egress proxy blocked api.slack.com, learn.microsoft.com,
    developer.pagerduty.com and www.twilio.com.
  - The request and response shapes, status codes, Slack error codes, the Teams
    Workflows host names, PagerDuty's limits and Twilio's error codes are therefore
    taken from the providers' published contracts as previously known.
  - Each should be checked against current vendor documentation before a live
    qualification run. The constants are kept in one place per provider so that a
    correction stays local.
- Fixture-tested only. No real Teams, Slack, PagerDuty or Twilio endpoint was called.
- PagerDuty receives `trigger` events only. KEEL does not send `resolve` when an alert
  clears, because the task-82 lifecycle does not dispatch resolution events.
- Teams and Slack have no provider-side dedup. A request that timed out after reaching
  the provider can be posted twice when it is retried.
- SMS: one recipient per channel, Twilio only, and no delivery-status callback. Another
  provider means adding a module under `engine/notify/channels/` and listing it in
  `SUPPORTED_PROVIDERS`.
- `unconfigured` is final for that delivery. After fixing the setting, the next alert
  is sent. The cancelled one is not replayed.
- Plain `webhook` channels still store their URL in config, as before task 84. Use
  Teams or Slack, or a credential reference, when the address is a secret.

## Boundary tests

`engine/roadmap/notification-adapters.test.mjs` has 7 tests. They use an isolated
schema and a fixture `fetch`.
- Request and response fixtures for each adapter: success, throttle (429 with
  Retry-After), rejection, provider down (503) and missing setup.
- Unsupported endpoints and providers:
  - a legacy Office 365 connector address;
  - a non-Teams host;
  - a non-Slack host;
  - SMS provider `vonage`;
  - an unknown PagerDuty region;
  - a stored `vonage` row, which is cancelled and never sent.
- PagerDuty dedup stays the same through 429, 502 and 202, for an alert event and for a
  non-alert event.
- Refusals fail at once with no follow-up job.
- No secret appears in the delivery rows, the notify jobs, the channel configs, the
  evidence ledger or the thrown errors. The fixtures include providers that echo
  secrets and a network error that names the address.

Required mutations were each applied alone and then restored (2026-10-03):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Ignore Retry-After (always use the backoff) | 6 | 1 |
| Change the PagerDuty dedup key on retry (append the attempt) | 5 | 2 |
| Record the webhook secret URL in the delivered receipt | 5 | 2 |
| Extra: record an unredacted provider error | 6 | 1 |

Validation: `node --test engine/roadmap/notification-adapters.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs`
gives 12 pass, 0 fail.
- The task-20, task-82 and task-83 suites still pass (17 of 17).
- `portal/test/action.test.ts` passes 13 of 13.
- The UI harness passes 94 of 94, with PagerDuty and Slack fixtures on the
  notifications route.
