// engine/notify/channels/teams.mjs
//
// Roadmap task-84: Microsoft Teams through a Teams Workflows ("Post to a channel when a
// webhook request is received") incoming webhook. The address is a secret, so the
// channel stores `endpointRef` and the address is resolved only at send time.
//
// Contract (as implemented; see docs/roadmap/notification-adapters.md for what could
// not be re-verified): POST a `message` whose single attachment is an Adaptive Card;
// the workflow answers 202 (some tenants 200) once it has accepted the request. Whether
// the flow then posts to the channel is not reported back. Retired Office 365
// connector addresses (*.webhook.office.com) are not supported and stay unconfigured.
import { capText, configProblems, eventSummary, httpOutcome, httpsUrl, snippet } from './common.mjs';

export const PROVIDER = 'microsoft-teams';
export const LABEL = 'Microsoft Teams';
export const SEMANTICS = 'Accepted by the Teams workflow. KEEL is not told whether the flow then posted to the channel.';

const WORKFLOW_HOSTS = [/\.logic\.azure\.com$/i, /\.environment\.api\.powerplatform\.com$/i];
const RETIRED_HOSTS = [/(^|\.)webhook\.office\.com$/i, /^outlook\.office(365)?\.com$/i];
const TEXT_LIMIT = 1000;

export function validateConfig(config) {
  return configProblems(config, { references: ['endpointRef'] });
}

function card(event) {
  const facts = [
    ['Event', event.kind],
    ['Severity', event.severity],
    ['Resource', event.resourceKey],
    ['Condition', event.control && event.condition ? `${event.control} / ${event.condition}` : null],
    ['Occurrence', event.occurrence],
    ['Acknowledge by', event.ackDeadlineAt],
    ['Alert ID', event.alertId],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([title, value]) => ({ title, value: capText(value, 200) }));
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: capText(eventSummary(event), TEXT_LIMIT), weight: 'Bolder', wrap: true },
          { type: 'FactSet', facts },
        ],
      },
    }],
  };
}

export async function prepare({ config, event, secret }) {
  const address = await secret(config.endpointRef);
  if (!address) return { unconfigured: `the credential reference ${config.endpointRef} has no value` };
  const url = httpsUrl(address);
  if (!url) return { unconfigured: 'the webhook address is not an https URL' };
  if (RETIRED_HOSTS.some((host) => host.test(url.hostname))) {
    return { unconfigured: 'the address is a retired Office 365 connector webhook. Create a Teams Workflows webhook and store its address instead' };
  }
  if (!WORKFLOW_HOSTS.some((host) => host.test(url.hostname))) {
    return { unconfigured: `${url.hostname} is not a Teams Workflows webhook host` };
  }
  return {
    url,
    endpointHost: url.hostname,
    secrets: [address, url.href, url.search],
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card(event)) },
  };
}

export function interpret({ status, body }) {
  const outcome = httpOutcome(status);
  if (outcome === 'delivered') return { outcome };
  if (outcome === 'retry') return { outcome, detail: `is throttling or unavailable (HTTP ${status})` };
  if ([401, 403, 404].includes(status)) {
    return { outcome, detail: `refused the address (HTTP ${status}). The workflow may be turned off or deleted` };
  }
  return { outcome, detail: `refused the message (HTTP ${status})${body ? `: ${snippet(body)}` : ''}` };
}
