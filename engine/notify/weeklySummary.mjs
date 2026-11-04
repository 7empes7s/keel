// engine/notify/weeklySummary.mjs
//
// Issue #980: the weekly summary, sent where admins already work. One change feed read
// for the last 7 days (the same read as the Insights page, with "Hide people's names"
// applied), turned into a `summary.weekly` event (insights/summary.mjs) and sent through
// the durable delivery path every alert takes (notifications.mjs).
//
//  - The scheduled job (`insights-summary`) sends it to every channel with an explicit
//    "Weekly summary" rule, once per channel and ISO week: rerunning the week's job adds
//    no second delivery.
//  - "Send this week's summary now" queues one delivery to one channel, whenever asked.
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { readNamer } from '../insights/anonymity.mjs';
import { loadChangeFeed } from '../insights/feed.mjs';
import { SUMMARY_DAYS, SUMMARY_EVENT_KIND, buildWeeklySummary } from '../insights/summary.mjs';
import {
  CHANNEL_NOT_FOUND, CHANNEL_OFF, DEFAULT_DELIVERY_MAX_ATTEMPTS, SubscriptionRefusedError, dispatchAlert,
  queueDelivery, subscriptionRefusal,
} from './notifications.mjs';

/** The summary event for the week ending `now`. Read-only. */
export async function weeklySummaryEvent(client, { tenantRef, now = new Date(), portalUrl = process.env.KEEL_PORTAL_URL }) {
  const namer = await readNamer(client);
  const feed = await loadChangeFeed(client, { tenantRef, now, days: SUMMARY_DAYS, namer });
  return buildWeeklySummary(feed, { now, portalUrl });
}

/** The key that keeps one week's summary to one delivery per channel. */
export const weeklyDedupKey = (event) => `${event.kind}:${event.week}`;

/**
 * The scheduled run: one delivery per subscribed channel, at most once a week each.
 * @returns {Promise<{ event: object, deliveries: { delivery: object, job: object }[] }>}
 */
export async function sendWeeklySummary(client, { tenantRef, requestedBy, now = new Date(), portalUrl, maxAttempts = DEFAULT_DELIVERY_MAX_ATTEMPTS }) {
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  const event = await weeklySummaryEvent(client, { tenantRef, now, portalUrl });
  const deliveries = await dispatchAlert(client, { event, requestedBy, maxAttempts, dedupKey: weeklyDedupKey(event) });
  return { event, deliveries };
}

/**
 * "Send this week's summary now": one delivery to one channel, through the same durable
 * path. Needs the same capability as managing channels.
 */
export async function sendSummaryNow(client, { tenantRef, channelId, requestedBy, now = new Date(), portalUrl, maxAttempts = DEFAULT_DELIVERY_MAX_ATTEMPTS }) {
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  const requester = await findPrincipalById(client, requestedBy);
  if (!(await can(client, requester, 'configuration', new Date()))) {
    throw new Error('requester is not authorized to dispatch notifications');
  }
  const { rows: [channel] } = await client.query('SELECT id, kind, enabled FROM channel WHERE id = $1', [channelId]);
  if (!channel) throw new Error(CHANNEL_NOT_FOUND);
  const refusal = subscriptionRefusal(channel.kind, SUMMARY_EVENT_KIND);
  if (refusal) throw new SubscriptionRefusedError(refusal);
  if (!channel.enabled) throw new Error(CHANNEL_OFF);
  const event = await weeklySummaryEvent(client, { tenantRef, now, portalUrl });
  await client.query('BEGIN');
  try {
    const queued = await queueDelivery(client, { event, channelId: channel.id, requestedBy, maxAttempts });
    await client.query('COMMIT');
    return queued;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
