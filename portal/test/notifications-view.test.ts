import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Channel, Delivery, EscalationRule, Subscription } from "@/lib/notifications";
import {
  channelHealth,
  channelName,
  criticalCovered,
  dayLabel,
  deliveryHref,
  deliveryProblem,
  deliveryTitle,
  durationWords,
  escalationOwner,
  escalationTitle,
  eventWords,
  notificationCounts,
  notificationsStatus,
  notificationsVerdict,
  orderChannels,
  ruleSentence,
  severityWords,
  writeError,
} from "@/lib/notifications-view";

// The Notifications page in words: the failing channel comes first, every provider error
// is a plain sentence with what to do, rules name real alerts, and no id leaks.

const NOW = "2026-10-02T09:40:00Z";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const WEBHOOK: Channel = { id: "c4e10000-0000-4000-8000-0000000000c1", kind: "webhook", config: { url: "https://hooks.contoso.com/keel" }, enabled: true, created_at: "2026-09-01T08:00:00Z" };
const EMAIL: Channel = { id: "c4e10000-0000-4000-8000-0000000000c2", kind: "email", config: { to: "secops@contoso.com", from: "keel@contoso.com" }, enabled: true, created_at: "2026-09-01T08:05:00Z" };
const PAGERDUTY: Channel = { id: "c4e10000-0000-4000-8000-0000000000c3", kind: "pagerduty", config: { routingKeyRef: "env:KEEL_PAGERDUTY_KEY", region: "eu" }, enabled: true, created_at: "2026-09-02T08:00:00Z" };
const SLACK: Channel = { id: "c4e10000-0000-4000-8000-0000000000c4", kind: "slack", config: { endpointRef: "env:KEEL_SLACK_WEBHOOK" }, enabled: true, created_at: "2026-09-03T08:00:00Z" };
const TEAMS_OFF: Channel = { id: "c4e10000-0000-4000-8000-0000000000c5", kind: "teams", config: { endpointRef: "env:KEEL_TEAMS_WEBHOOK" }, enabled: false, created_at: "2026-08-20T08:00:00Z" };
const CHANNELS = [WEBHOOK, EMAIL, PAGERDUTY, SLACK, TEAMS_OFF];

const ALERT = { alertId: "a1e70000-0000-4000-8000-000000000001", resourceKey: "conditionalAccessPolicy:Block legacy auth", control: "baseline", condition: "drift", occurrence: 1 };
const delivery = (over: Partial<Delivery> & { channel: Channel }): Delivery => ({
  id: `d0e10000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`,
  event: { kind: "alert.opened", severity: "critical", ...ALERT },
  channel_id: over.channel.id, channel_kind: over.channel.kind, status: "delivered", attempts: 1, last_error: null, next_attempt_at: null,
  created_at: "2026-10-02T09:38:00Z", delivered_at: "2026-10-02T09:38:04Z",
  ...over,
});

const DELIVERIES: Delivery[] = [
  delivery({ channel: WEBHOOK, status: "retrying", attempts: 2, last_error: "the webhook did not answer in time", next_attempt_at: "2026-10-02T09:45:00Z", delivered_at: null }),
  delivery({ channel: EMAIL }),
  delivery({ channel: PAGERDUTY, attempts: 2, delivered_at: "2026-10-02T09:38:40Z" }),
  delivery({ channel: SLACK, status: "failed", event: { kind: "alert.reopened", severity: "warning", ...ALERT, occurrence: 2 }, last_error: "Slack refused the message (HTTP 404): the webhook was removed or turned off", created_at: "2026-10-02T09:12:00Z", delivered_at: null, provider_receipt: { channel: "slack", provider: "slack", outcome: "rejected", httpStatus: 404, endpointHost: "hooks.slack.com", providerStatus: "no_service" } }),
  delivery({ channel: SLACK, status: "delivered", event: { kind: "test", severity: "notice" }, created_at: "2026-10-01T16:02:00Z", delivered_at: "2026-10-01T16:02:01Z" }),
  delivery({ channel: TEAMS_OFF, created_at: "2026-09-29T11:00:00Z", delivered_at: "2026-09-29T11:00:02Z" }),
];

const RULES: Subscription[] = [
  { id: "5b500000-0000-4000-8000-0000000000f1", channel_id: WEBHOOK.id, event_glob: "*", min_severity: "warning" },
  { id: "5b500000-0000-4000-8000-0000000000f2", channel_id: EMAIL.id, event_glob: "alert.opened", min_severity: "critical" },
  { id: "5b500000-0000-4000-8000-0000000000f3", channel_id: SLACK.id, event_glob: "alert.reopened", min_severity: "warning" },
];

const ESCALATION: EscalationRule = { id: "e5c10000-0000-4000-8000-0000000000e1", control: null, min_severity: "critical", ack_within_ms: 30 * 60_000, enabled: true, owner_principal_id: "8c1e0000-0000-4000-8000-0000000000b3", owner_name: "Sam Ortiz", owner_email: "sam.ortiz@contoso.example", owner_disabled_at: null, escalate_channel_id: PAGERDUTY.id };

test("channels are named in words and ordered failing first", () => {
  assert.equal(channelName(WEBHOOK), "Web address hooks.contoso.com");
  assert.equal(channelName(EMAIL), "Email to secops@contoso.com");
  assert.equal(channelName(PAGERDUTY), "PagerDuty (EU)");
  assert.equal(channelName(TEAMS_OFF), "Microsoft Teams");
  assert.deepEqual(orderChannels(CHANNELS, DELIVERIES, NOW).map((channel) => channel.kind), ["slack", "webhook", "pagerduty", "email", "teams"]);
});

test("a channel's health comes from its newest send, in plain words", () => {
  const slack = channelHealth(SLACK, DELIVERIES, NOW);
  assert.equal(slack.state, "failing");
  assert.equal(slack.badge.label, "Failing");
  assert.equal(slack.line, "Last try 28 minutes ago · Slack refused it: the address was removed.");
  assert.equal(slack.problem?.whatToDo, "Make a new address in Slack, add it here as a new channel, then turn this one off.");
  const webhook = channelHealth(WEBHOOK, DELIVERIES, NOW);
  assert.equal(webhook.state, "retrying");
  assert.equal(webhook.line, "After 2 tries · next try in 5 minutes");
  const pagerduty = channelHealth(PAGERDUTY, DELIVERIES, NOW);
  assert.equal(pagerduty.state, "working");
  assert.equal(pagerduty.line, "Last sent 1 minute ago · delivered after 2 tries");
  assert.equal(channelHealth(TEAMS_OFF, DELIVERIES, NOW).state, "off");
  assert.equal(channelHealth({ id: "c4e10000-0000-4000-8000-0000000000c6", enabled: true }, DELIVERIES, NOW).line, "Nothing has been sent through it yet. Send a test.");
  for (const channel of CHANNELS) assert.doesNotMatch(channelHealth(channel, DELIVERIES, NOW).line, UUID);
});

test("provider errors become a sentence and a next step; codes stay out of them", () => {
  const refused = deliveryProblem({ status: "failed", attempts: 1, channel_kind: "slack", last_error: "Slack refused the message (HTTP 404): the webhook was removed or turned off", provider_receipt: { httpStatus: 404, outcome: "rejected" } });
  assert.equal(refused?.sentence, "Slack refused it: the address was removed.");
  assert.doesNotMatch(refused?.sentence ?? "", /404|HTTP/);
  assert.equal(deliveryProblem({ status: "failed", attempts: 5, channel_kind: "teams", last_error: "Teams refused the message (HTTP 403)", provider_receipt: { httpStatus: 403 } })?.sentence, "Microsoft Teams refused it: the key or address is no longer accepted.");
  assert.equal(deliveryProblem({ status: "retrying", attempts: 1, channel_kind: "pagerduty", last_error: "PagerDuty asked Keel to slow down (HTTP 429)", provider_receipt: { httpStatus: 429 } })?.whatToDo, "Keel tries again on its own.");
  assert.equal(deliveryProblem({ status: "retrying", attempts: 2, channel_kind: "webhook", last_error: "the webhook did not answer in time", provider_receipt: null })?.sentence, "It did not answer in time.");
  assert.equal(deliveryProblem({ status: "failed", attempts: 1, channel_kind: "webhook", last_error: "the hook said no (HTTP 418)", provider_receipt: null })?.sentence, "The hook said no.");
  assert.equal(deliveryProblem({ status: "delivered", attempts: 1, channel_kind: "email", last_error: null, provider_receipt: null }), null);
});

test("sent rows are titled by what they were about and link to the alert", () => {
  assert.equal(deliveryTitle(DELIVERIES[0]), "Alert opened: Block legacy auth (sign-in rule)");
  assert.equal(deliveryTitle(DELIVERIES[3]), "Alert came back: Block legacy auth (sign-in rule)");
  assert.equal(deliveryTitle(DELIVERIES[4]), "Test alert");
  assert.equal(deliveryTitle({ event: { kind: "alert.escalated", severity: "critical" } }), "Nobody responded");
  assert.equal(deliveryHref(DELIVERIES[0]), "/alerts?open=a1e70000-0000-4000-8000-000000000001");
  assert.equal(deliveryHref(DELIVERIES[4]), null);
  assert.equal(dayLabel("2026-10-02T03:10:00Z", NOW), "Today");
  assert.equal(dayLabel("2026-10-01T16:02:00Z", NOW), "Yesterday");
  assert.equal(dayLabel("2026-09-29T11:00:00Z", NOW), "Tuesday 29 September");
});

test("rules name the alerts Keel really sends", () => {
  assert.equal(eventWords("*"), "All alerts");
  assert.equal(eventWords("alert.opened"), "An alert opened");
  assert.equal(eventWords("alert.reopened"), "An alert came back");
  assert.equal(eventWords("drift.*"), "Events matching “drift.*”");
  assert.equal(severityWords("critical"), "Critical only");
  assert.equal(severityWords("warning"), "Warning or above");
  assert.equal(severityWords("notice"), "All severities");
  assert.equal(ruleSentence(RULES[0], WEBHOOK), "Sends every alert rated warning or above to Web address hooks.contoso.com.");
  assert.equal(ruleSentence(RULES[1], EMAIL), "Sends “an alert opened” alerts rated critical or above to Email to secops@contoso.com.");
  assert.equal(ruleSentence({ event_glob: "*", min_severity: "notice" }, null), "Sends every alert to a channel that is no longer readable.");
  assert.equal(criticalCovered(RULES, CHANNELS), true);
  assert.equal(criticalCovered([RULES[2]], [{ ...SLACK, enabled: false }]), false);
});

test("escalation rules read as a sentence with the owner's name", () => {
  assert.equal(escalationTitle(ESCALATION), "A critical alert not acknowledged in 30 minutes");
  assert.equal(escalationTitle({ min_severity: "notice", ack_within_ms: 4 * 3_600_000 }), "Any alert not acknowledged in 4 hours");
  assert.equal(durationWords(15 * 60_000), "15 minutes");
  assert.equal(durationWords(3_600_000), "1 hour");
  assert.equal(durationWords(2 * 24 * 3_600_000), "2 days");
  assert.equal(escalationOwner(ESCALATION), "Sam Ortiz");
  assert.equal(escalationOwner({ ...ESCALATION, owner_name: null, owner_email: "dana.oncall@contoso.example" }), "Dana Oncall");
  assert.equal(escalationOwner({ ...ESCALATION, owner_disabled_at: "2026-10-01T00:00:00Z" }), "an account that no longer exists");
  assert.equal(escalationOwner({ ...ESCALATION, owner_principal_id: null }), null);
});

test("the counts behind the tiles", () => {
  const counts = notificationCounts({ channels: CHANNELS, subscriptions: RULES, escalationRules: [ESCALATION], deliveries: DELIVERIES }, NOW);
  assert.equal(counts.channelsOn, 4);
  assert.equal(counts.channelsTotal, 5);
  assert.deepEqual(counts.offNames, ["Microsoft Teams"]);
  assert.deepEqual(counts.failingNames, ["Slack"]);
  assert.equal(counts.rules, 3);
  assert.equal(counts.escalationsOn, 1);
  assert.equal(counts.sentDay, 5);
  assert.equal(counts.failedDay, 1);
  assert.equal(counts.buckets.length, 8);
  assert.equal(counts.buckets.reduce((sum, value) => sum + value, 0), 5);
});

test("the status pill and the verdict name the failing channel first", () => {
  const counts = notificationCounts({ channels: CHANNELS, subscriptions: RULES, escalationRules: [], deliveries: DELIVERIES }, NOW);
  assert.deepEqual(notificationsStatus(counts, { channels: CHANNELS, subscriptions: RULES }), { tone: "urgent", label: "Slack is failing" });
  const verdict = notificationsVerdict({ channels: CHANNELS, subscriptions: RULES, deliveries: DELIVERIES }, NOW);
  assert.equal(verdict.text, "Slack has been failing for 28 minutes; the other 3 channels work.");
  assert.equal(verdict.detail, "Slack refused it: the address was removed. Make a new address in Slack, add it here as a new channel, then turn this one off.");
  assert.equal(verdict.action, "test");
  assert.equal(verdict.channelId, SLACK.id);
  assert.equal(verdict.tone, "attention");

  const healthy = DELIVERIES.filter((entry) => entry.status !== "failed" && entry.status !== "retrying");
  const fine = notificationsVerdict({ channels: CHANNELS, subscriptions: RULES, deliveries: healthy }, NOW);
  assert.equal(fine.text, "Alerts go to the web address hooks.contoso.com, the email to secops@contoso.com, PagerDuty (EU) and Slack.");
  assert.equal(fine.action, null);
  assert.equal(fine.tone, "good");
  assert.deepEqual(notificationsStatus(notificationCounts({ channels: CHANNELS, subscriptions: RULES, escalationRules: [], deliveries: healthy }, NOW), { channels: CHANNELS, subscriptions: RULES }), { tone: "fine", label: "Alerts are arriving" });

  const none = notificationsVerdict({ channels: [], subscriptions: [], deliveries: [] }, NOW);
  assert.equal(none.action, "add-channel");
  const noRules = notificationsVerdict({ channels: [EMAIL], subscriptions: [], deliveries: [] }, NOW);
  assert.equal(noRules.action, "add-rule");
  assert.equal(noRules.text, "Channels are set up, but no rule sends anything to them.");
  const allOff = notificationsVerdict({ channels: [TEAMS_OFF], subscriptions: RULES, deliveries: [] }, NOW);
  assert.equal(allOff.action, "turn-on");
  assert.deepEqual(notificationsStatus(notificationCounts({ channels: [TEAMS_OFF], subscriptions: RULES, escalationRules: [], deliveries: [] }, NOW), { channels: [TEAMS_OFF], subscriptions: RULES }), { tone: "urgent", label: "No channel is on" });
  assert.deepEqual(notificationsStatus(notificationCounts({ channels: [EMAIL], subscriptions: [{ ...RULES[2], channel_id: EMAIL.id, event_glob: "drift.detected" }], escalationRules: [], deliveries: [] }, NOW), { channels: [EMAIL], subscriptions: [{ ...RULES[2], channel_id: EMAIL.id, event_glob: "drift.detected" }] }), { tone: "soon", label: "No rule sends critical alerts" });

  // A viewer without configuration sees counts only.
  const viewer = notificationsVerdict({ channels: null, subscriptions: [], deliveries: DELIVERIES }, NOW);
  assert.equal(viewer.text, "6 alerts were sent recently; 1 failed.");
  for (const text of [verdict.text, verdict.detail ?? "", fine.text, viewer.text]) assert.doesNotMatch(text, UUID);
});

test("a refused write is explained in words", () => {
  assert.equal(writeError(403, null), "Your access does not allow changing notification settings.");
  assert.equal(writeError(409, { error: "channel_off" }), "This channel is turned off. Turn it back on to send a test.");
  assert.equal(writeError(400, { error: "provider is required (supported: twilio)" }), "provider is required (supported: twilio)");
  assert.equal(writeError(400, { error: "invalid_request" }), "Keel could not read the form. Check the fields and try again.");
  assert.equal(writeError(0, null), "Keel could not be reached. Check the connection and try again.");
});
