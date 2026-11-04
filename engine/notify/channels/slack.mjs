// engine/notify/channels/slack.mjs
//
// Roadmap task-84: a Slack app incoming webhook (https://hooks.slack.com/services/...).
// The address is the credential, so the channel stores `endpointRef` only.
//
// Contract (as implemented; see docs/roadmap/notification-adapters.md): POST JSON with
// `text`; 200 with body `ok` means Slack posted it. Errors come back as a 4xx with a
// plain-text code (invalid_payload, no_text, no_service, channel_not_found,
// channel_is_archived, action_prohibited, ...), and none of those improve on retry.
// 429 carries Retry-After.
import { SUMMARY_EVENT_KIND, startLine } from '../../insights/summary.mjs';
import { capText, configProblems, eventSummary, httpOutcome, httpsUrl, snippet } from './common.mjs';

export const PROVIDER = 'slack';
export const LABEL = 'Slack';
export const SEMANTICS = "Posted by Slack to the webhook's channel.";

const TEXT_LIMIT = 3000;
// Slack's error codes in words; the raw code stays in the receipt.
const REASONS = Object.freeze({
  no_service: 'the webhook was removed or turned off',
  invalid_token: 'the webhook is no longer valid',
  channel_not_found: 'its channel no longer exists',
  channel_is_archived: 'its channel is archived',
  action_prohibited: 'a Slack admin blocked posting to its channel',
  invalid_payload: 'Slack could not read the message',
  no_text: 'Slack could not read the message',
});

export function validateConfig(config) {
  return configProblems(config, { references: ['endpointRef'] });
}

// Slack treats &, < and > as control characters in message text.
const escapeText = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Issue #980: the weekly summary as text (this adapter has no blocks), with the link to
// Insights as a Slack link when it is a full address.
export function summaryMessage(event) {
  const items = Array.isArray(event.whereToStart) ? event.whereToStart : [];
  const link = typeof event.link === 'string' ? event.link : '';
  const lines = [`*${escapeText(event.title ?? 'Keel weekly summary')}*`, escapeText(event.verdict ?? '')];
  if (items.length) lines.push('', '*Where to start*', ...items.map((item) => `• ${escapeText(startLine(item))}`));
  const rest = [event.byServiceLine, event.quietLine].filter(Boolean).map(escapeText);
  if (rest.length) lines.push('', ...rest);
  lines.push('', /^https:\/\//.test(link) ? `<${link}|Open Insights>` : `Open Insights in Keel: ${escapeText(link)}`);
  return { text: capText(lines.join('\n'), TEXT_LIMIT), unfurl_links: false, unfurl_media: false };
}

function message(event) {
  if (event.kind === SUMMARY_EVENT_KIND) return summaryMessage(event);
  const lines = [eventSummary(event)];
  if (event.ackDeadlineAt) lines.push(`Acknowledge by ${event.ackDeadlineAt}.`);
  if (event.alertId) lines.push(`Alert ${event.alertId}, occurrence ${event.occurrence ?? 1}.`);
  return { text: capText(escapeText(lines.join('\n')), TEXT_LIMIT), unfurl_links: false, unfurl_media: false };
}

export async function prepare({ config, event, secret }) {
  const address = await secret(config.endpointRef);
  if (!address) return { unconfigured: `the credential reference ${config.endpointRef} has no value` };
  const url = httpsUrl(address);
  if (!url || url.hostname !== 'hooks.slack.com' || !url.pathname.startsWith('/services/')) {
    return { unconfigured: 'the address is not a Slack incoming webhook (https://hooks.slack.com/services/...)' };
  }
  return {
    url,
    endpointHost: url.hostname,
    secrets: [address, url.href, url.pathname],
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message(event)) },
  };
}

export function interpret({ status, body }) {
  const outcome = httpOutcome(status);
  const code = snippet(body, 80);
  if (outcome === 'delivered') return { outcome, receipt: { providerStatus: code || null } };
  if (outcome === 'retry') return { outcome, detail: `is throttling or unavailable (HTTP ${status})` };
  const reason = REASONS[code] ?? (code ? `Slack said ${code}` : null);
  return { outcome, detail: `refused the message (HTTP ${status})${reason ? `: ${reason}` : ''}`, receipt: { providerStatus: code || null } };
}
