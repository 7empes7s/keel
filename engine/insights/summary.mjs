/**
 * The weekly summary (issue #980): the Insights page's answer to "what changed this week
 * and where do I start?", as a notification event of its own kind. Built from the same
 * code as the page (view.mjs) over the same change feed read (feed.mjs, last 7 days), so
 * it follows the page's rules: "Hide people's names" gives code names (the feed applies
 * them before this sees a row), there are no ids anywhere, and no setting values beyond
 * what the flag sentences already show. Pure.
 */
import { changesByService, insightsVerdict, quietServices, whereToStart } from './view.mjs';

export const SUMMARY_EVENT_KIND = 'summary.weekly';
export const SUMMARY_DAYS = 7;
export const SUMMARY_START_LIMIT = 5;
export const SUMMARY_TITLE = 'Keel weekly summary';
export const SUMMARY_LINK_PATH = `/insights?days=${SUMMARY_DAYS}`;

// Channels that cannot carry the summary, with the reason a person reads. A rule for
// them is refused (notify/notifications.mjs), and the portal's rule form says why.
export const SUMMARY_REFUSED_CHANNEL_KINDS = Object.freeze({
  pagerduty: 'PagerDuty opens an incident for every event it gets, so it cannot get the weekly summary. Send the summary to email, Teams, Slack or a web address instead.',
  sms: 'A text message is too short for the weekly summary. Send the summary to email, Teams, Slack or a web address instead.',
});

/**
 * The ISO week a moment falls in: "2026-W45". A rerun in the same week gets the same
 * week, so it does not send twice.
 * @param {Date | string} now
 * @returns {string}
 */
export function isoWeek(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.valueOf())) throw new TypeError('isoWeek needs a valid date');
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.valueOf() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The link to Insights for the last 7 days: the portal's public https address
 * (KEEL_PORTAL_URL) plus /insights?days=7, or the bare path when no address is set.
 * @param {string | null | undefined} portalUrl
 * @returns {string}
 */
export function summaryLink(portalUrl) {
  const configured = typeof portalUrl === 'string' ? portalUrl.trim() : '';
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' && !url.username && !url.password) return `${url.origin}${SUMMARY_LINK_PATH}`;
    } catch {
      // Not an address: fall back to the path.
    }
  }
  return SUMMARY_LINK_PATH;
}

const listWords = (items) => (items.length <= 1 ? items[0] ?? '' : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The summary event for one change feed read.
 * @param {{ rows: object[], truncated: boolean, since: string, until: string }} feed
 * @param {{ now?: Date | string, portalUrl?: string | null }} [options]
 */
export function buildWeeklySummary(feed, { now = new Date(), portalUrl = null } = {}) {
  const at = new Date(now).toISOString();
  const period = String(SUMMARY_DAYS);
  const verdict = insightsVerdict(feed, period).text;
  const link = summaryLink(portalUrl);
  const start = whereToStart(feed.rows, period, at);
  // Flagged first, then the unflagged changes to critical or high kinds, as on the page.
  const items = [...start.flagged, ...start.watch].slice(0, SUMMARY_START_LIMIT).map((item) => ({
    sentence: item.sentence,
    // What a rule says the change does, when one knows it ("Turned off: Require MFA.").
    does: item.flags[0]?.sentence ?? null,
    who: item.who,
    what: item.objectName,
    when: item.when,
  }));
  const byService = changesByService(feed.rows, period).map((bar) => ({ service: bar.label, count: bar.count }));
  const quiet = feed.rows.length ? quietServices(feed.rows) : [];
  const byServiceLine = byService.length
    ? `Changes by service: ${byService.map((entry) => `${entry.service} ${entry.count.toLocaleString('en-GB')}`).join(', ')}.`
    : null;
  const quietLine = quiet.length ? `No changes in ${listWords(quiet)}.` : null;
  return {
    kind: SUMMARY_EVENT_KIND,
    severity: 'notice',
    week: isoWeek(at),
    since: feed.since,
    until: feed.until,
    days: SUMMARY_DAYS,
    title: SUMMARY_TITLE,
    verdict,
    whereToStart: items,
    changesByService: byService,
    byServiceLine,
    quietServices: quiet,
    quietLine,
    link,
    text: summaryText({ verdict, whereToStart: items, byServiceLine, quietLine, link }),
  };
}

/** One "Where to start" item as one line: the sentence, then what a rule says it does. */
export const startLine = (item) => (item.does ? `${item.sentence} ${item.does}` : item.sentence);

/**
 * The summary as plain text, for email, Slack and anything without a richer shape.
 * @returns {string}
 */
export function summaryText({ verdict, whereToStart: items = [], byServiceLine = null, quietLine = null, link }) {
  const lines = [SUMMARY_TITLE, '', verdict];
  if (items.length) lines.push('', 'Where to start:', ...items.map((item) => `- ${startLine(item)}`));
  if (byServiceLine || quietLine) lines.push('', ...[byServiceLine, quietLine].filter(Boolean));
  lines.push('', `Open Insights: ${link}`);
  return lines.join('\n');
}

export const isSummaryEvent = (event) => event?.kind === SUMMARY_EVENT_KIND;
