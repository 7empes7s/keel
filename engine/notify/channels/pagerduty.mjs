// engine/notify/channels/pagerduty.mjs
//
// Roadmap task-84: PagerDuty Events API v2 (`trigger` events). The integration's
// routing key is the credential, so the channel stores `routingKeyRef`.
//
// Contract (as implemented; see docs/roadmap/notification-adapters.md): POST JSON to
// /v2/enqueue in the account's region; 202 with {status:"success", dedup_key} means
// PagerDuty accepted the event. 400 is an invalid event, 429 is throttling.
//
// Dedup is PagerDuty's own: the dedup_key is derived from the alert and its occurrence
// (or, for a non-alert event, the delivery), never from the attempt, so a retried send
// and the later escalation of the same occurrence land on the same incident.
import { boundedKey, capText, configProblems, eventSummary, httpOutcome, parseJson, snippet } from './common.mjs';

export const PROVIDER = 'pagerduty';
export const LABEL = 'PagerDuty';
export const SEMANTICS = 'Accepted by PagerDuty. Events with the same dedup key join one incident.';

export const REGIONS = Object.freeze({
  us: 'https://events.pagerduty.com/v2/enqueue',
  eu: 'https://events.eu.pagerduty.com/v2/enqueue',
});
const SEVERITY = Object.freeze({ critical: 'critical', warning: 'warning', notice: 'info' });
const SUMMARY_LIMIT = 1024;
const FIELD_LIMIT = 255;
const DETAILS_LIMIT = 16 * 1024;

export function validateConfig(config) {
  const problems = configProblems(config, { references: ['routingKeyRef'], allowed: ['region'] });
  if (config.region !== undefined && !(config.region in REGIONS)) problems.push('region must be us or eu');
  return problems;
}

export function dedupKey(event, delivery) {
  const key = event.alertId
    ? `keel:alert:${event.alertId}:${event.occurrence ?? 1}`
    : `keel:delivery:${delivery.id}`;
  return boundedKey(key, FIELD_LIMIT);
}

function details(event) {
  const text = JSON.stringify(event);
  return text.length <= DETAILS_LIMIT ? event : { kind: event.kind, note: 'event details were too large to send' };
}

export async function prepare({ config, event, delivery, secret }) {
  const routingKey = await secret(config.routingKeyRef);
  if (!routingKey) return { unconfigured: `the credential reference ${config.routingKeyRef} has no value` };
  const url = new URL(REGIONS[config.region ?? 'us']);
  const key = dedupKey(event, delivery);
  const body = {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: key,
    client: 'KEEL',
    payload: {
      summary: capText(eventSummary(event), SUMMARY_LIMIT),
      source: capText(event.tenantRef ? `keel:${event.tenantRef}` : 'keel', FIELD_LIMIT),
      severity: SEVERITY[event.severity] ?? 'info',
      ...(event.resourceKey ? { component: capText(event.resourceKey, FIELD_LIMIT) } : {}),
      ...(event.control ? { group: capText(event.control, FIELD_LIMIT) } : {}),
      class: capText(event.kind, FIELD_LIMIT),
      custom_details: details(event),
    },
  };
  return {
    url,
    endpointHost: url.hostname,
    secrets: [routingKey],
    receipt: { dedupKey: key },
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  };
}

export function interpret({ status, body }) {
  const outcome = httpOutcome(status);
  const json = parseJson(body);
  if (outcome === 'delivered') {
    return { outcome, receipt: { providerStatus: json?.status ?? null, providerDedupKey: json?.dedup_key ?? null } };
  }
  if (outcome === 'retry') return { outcome, detail: `is throttling or unavailable (HTTP ${status})` };
  const reason = [json?.message, ...(Array.isArray(json?.errors) ? json.errors : [])].filter(Boolean).join('; ');
  return { outcome, detail: `refused the event (HTTP ${status})${reason ? `: ${snippet(reason)}` : ''}` };
}
