import assert from "node:assert/strict";
import { test } from "node:test";

import { ALERT_ROUTES, alertCall, alertCallWords } from "@/lib/alert-calls";
import {
  actionable,
  alertCounts,
  alertMatches,
  alertService,
  alertTitle,
  alertsStatus,
  bulkDetail,
  changeLink,
  deadlineWords,
  escalationWords,
  parseAlertFilter,
  shortSpan,
  type AlertItem,
} from "@/lib/alerts-view";
import { renderAlertsAt } from "./render-alerts";

// The Alerts page's words and calls, without a browser: counts, the header pill, the
// tile filters, the row countdown, the pre-action sentence, the link to the change, and
// which route each control posts to.

const NOW = "2026-10-02T09:40:00Z";
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let seq = 0;
const alert = (over: Partial<AlertItem>): AlertItem => ({
  id: `a1e70000-0000-4000-8000-00000000000${(seq += 1) % 10}`, resourceKey: "group:Finance", name: "Finance", control: "baseline", condition: "drift",
  state: "open", conditionActive: true, severity: "warning", occurrence: 1, firstOpenedAt: "2026-10-02T09:00:00Z",
  occurrenceStartedAt: "2026-10-02T09:00:00Z", lastFiringAt: "2026-10-02T09:00:00Z", ackDeadlineAt: null,
  acknowledgedAt: null, acknowledgedByName: null, owner: null, escalated: false, escalationError: null,
  cause: { changeType: "modified", resourceType: "group", snapshotId: null }, lastEventId: "drift:1", history: [], ...over,
});

const OVERDUE = alert({ id: "a1e70000-0000-4000-8000-000000000001", state: "reopened", severity: "critical", ackDeadlineAt: "2026-10-02T09:10:00Z", resourceKey: "conditionalAccessPolicy:Block legacy auth", name: "Block legacy auth", cause: { changeType: "modified", resourceType: "conditionalAccessPolicy", snapshotId: null } });
const WAITING = alert({ id: "a1e70000-0000-4000-8000-000000000002", ackDeadlineAt: "2026-10-02T12:40:00Z", owner: { id: "8c1e0000-0000-4000-8000-0000000000a3", name: "Dana Reyes" } });
const ACKED = alert({ id: "a1e70000-0000-4000-8000-000000000003", state: "acknowledged", acknowledgedAt: "2026-10-02T09:00:00Z", acknowledgedByName: "Marouane" });
const RESOLVED = alert({ id: "a1e70000-0000-4000-8000-000000000004", state: "resolved", conditionActive: false, history: [{ id: "1", occurrence: 1, fromState: "open", toState: "resolved", reason: "resolved-by-operator", actor: "x", actorName: "Marouane", at: "2026-09-30T09:00:00Z", eventId: null, note: "planned" }] });
const OLD_RESOLVED = alert({ id: "a1e70000-0000-4000-8000-000000000005", state: "resolved", conditionActive: false, history: [{ id: "2", occurrence: 1, fromState: "open", toState: "resolved", reason: "condition-resolved", actor: "x", actorName: null, at: "2026-09-01T09:00:00Z", eventId: null }] });
const MUTED = alert({ id: "a1e70000-0000-4000-8000-000000000006", state: "suppressed", severity: "notice" });
const ALL = [OVERDUE, WAITING, ACKED, RESOLVED, OLD_RESOLVED, MUTED];

test("counts, the header pill and the tile filters", () => {
  const counts = alertCounts(ALL, NOW);
  assert.deepEqual(counts, { waiting: 2, overdue: 1, acknowledged: 1, resolvedWeek: 1, muted: 1, total: 6 });
  assert.deepEqual(alertsStatus(counts), { tone: "urgent", label: "1 overdue" });
  assert.deepEqual(alertsStatus(alertCounts([WAITING], NOW)), { tone: "soon", label: "1 waiting" });
  assert.deepEqual(alertsStatus(alertCounts([ACKED], NOW)), { tone: "low", label: "1 in hand" });
  assert.deepEqual(alertsStatus(alertCounts([RESOLVED], NOW)), { tone: "fine", label: "All clear" });
  assert.equal(parseAlertFilter("overdue"), "overdue");
  assert.equal(parseAlertFilter("anything"), null);
  assert.deepEqual(ALL.filter((item) => alertMatches(item, "overdue", NOW)), [OVERDUE]);
  assert.deepEqual(ALL.filter((item) => alertMatches(item, "waiting", NOW)), [OVERDUE, WAITING]);
  assert.deepEqual(ALL.filter((item) => alertMatches(item, "muted", NOW)), [MUTED]);
});

test("rows count down to the deadline in short words", () => {
  assert.equal(shortSpan(30 * 60_000), "30 min");
  assert.equal(shortSpan(3 * 3_600_000), "3 h");
  assert.equal(shortSpan(3 * 86_400_000), "3 days");
  assert.deepEqual(deadlineWords(OVERDUE, NOW), { text: "Overdue 30 min", tone: "urgent" });
  assert.deepEqual(deadlineWords(WAITING, NOW), { text: "Due in 3 h", tone: null });
  assert.deepEqual(deadlineWords(alert({}), NOW), { text: "No deadline", tone: null });
  assert.equal(deadlineWords(ACKED, NOW).text, "Acknowledged 40 min ago");
  assert.equal(deadlineWords(RESOLVED, NOW).text, "Resolved 2 days ago");
  assert.equal(deadlineWords(MUTED, NOW).text, "Nobody is told");
});

test("titles use plain kind words, and the panel links to the change by name", () => {
  assert.equal(alertTitle(OVERDUE), "Block legacy auth (sign-in rule)");
  assert.deepEqual(changeLink(OVERDUE), { href: "/drift?q=Block%20legacy%20auth", label: "Open the change" });
  const site = alert({ resourceKey: "sharepoint-site-settings:site:contoso.sharepoint.com,1,2", name: "Finance team", cause: { changeType: "modified", resourceType: "sharepoint-site-settings", snapshotId: null } });
  assert.deepEqual(changeLink(site), { href: "/sites/contoso.sharepoint.com%2C1%2C2", label: "Open the site" });
  assert.equal(changeLink(alert({ control: "break-glass", condition: "emergency-account-used" })).href, "/readiness");
  assert.equal(alertService(OVERDUE).name, "Entra ID");
  assert.equal(alertService(site).name, "SharePoint and OneDrive");
  assert.equal(escalationWords("escalation-failed-no-recipient"), "Keel could not escalate it: no channel is set to tell anyone.");
  assert.equal(escalationWords(null), null);
});

test("a bulk action says what it will do, and what it leaves alone, before it runs", () => {
  assert.equal(bulkDetail("acknowledge", [OVERDUE, WAITING]), "2 alerts are marked as seen by you; they stay open until the change goes away.");
  assert.equal(bulkDetail("acknowledge", [OVERDUE, ACKED]), "1 alert is marked as seen by you; it stays open until the change goes away. 1 is already acknowledged or closed and stays as it is.");
  assert.equal(bulkDetail("resolve", [WAITING, ACKED, RESOLVED]), "2 alerts close now. If a change is still there, the next check opens it again. 1 is already closed and stays as it is.");
  assert.equal(bulkDetail("mute", [WAITING, MUTED]), "1 alert is muted: still recorded, but nobody is told. 1 is already muted and stays as it is.");
  assert.equal(actionable("unmute", MUTED), true);
  assert.equal(actionable("resolve", RESOLVED), false);
});

test("acknowledge and resolve post to the respond route, mute and unmute to the mute route", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ alert: { id: "x", state: "acknowledged" } });
  }) as typeof fetch;
  try {
    const result = await alertCall(OVERDUE.id, "acknowledge", "  on it  ");
    assert.deepEqual(result, { ok: true, status: 200, state: "acknowledged" });
    await alertCall(OVERDUE.id, "mute", "noise");
    await alertCall(OVERDUE.id, "unmute");
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(calls.map((call) => call.url), [ALERT_ROUTES.acknowledge, "/api/actions/alerts/mute", "/api/actions/alerts/mute"]);
  assert.equal(ALERT_ROUTES.resolve, "/api/actions/alerts");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { alertId: OVERDUE.id, action: "acknowledge", note: "on it" });
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { alertId: OVERDUE.id, action: "unmute" });
  const keys = calls.map((call) => new Headers(call.init.headers).get("idempotency-key"));
  assert.equal(new Set(keys).size, 3, "one idempotency key per call");
  assert.equal(alertCallWords({ ok: false, status: 409, state: null }), "Someone else changed it first. The list now shows where it stands.");
  assert.equal(alertCallWords({ ok: false, status: 403, state: null }), "You need the right role for that, or your sign-in has ended.");
});

test("the page body: tiles filter by state, closed groups stay counted, a viewer gets no amber action", async () => {
  const props = { alerts: ALL, now: NOW, canRespond: true, canMute: true };
  const html = await renderAlertsAt("", props);
  const tiles = [...html.matchAll(/class="al-tile"[^>]*href="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(tiles, ["/alerts?state=waiting", "/alerts?state=overdue", "/alerts?state=acknowledged", "/alerts?state=resolved"]);
  assert.match(html, /Acknowledge the overdue one/);
  // Resolved and Muted start closed, with their counts.
  assert.match(html, /<section class="sel-group" data-closed="true">[\s\S]*?Resolved[\s\S]*?2 alerts/);
  assert.equal([...html.matchAll(/class="al-row-link"/g)].length, 3, "only the open groups show rows");
  const filtered = await renderAlertsAt("state=overdue", props);
  assert.equal([...filtered.matchAll(/class="al-row-link"/g)].length, 1);
  assert.match(filtered, /Showing <b>1<\/b> of 6 alerts/);
  assert.match(filtered, /Remove filter: Past deadline/);
  // Tiles add up: from Past deadline, Resolved adds to it.
  assert.ok(filtered.includes(`href="/alerts?state=overdue%2Cresolved"`), "a second tile adds to the first");
  const both = await renderAlertsAt("state=overdue,resolved", props);
  assert.equal([...both.matchAll(/class="al-row-link"/g)].length, 3, "past deadline or resolved: 1 + 2");
  assert.match(both, /Showing <b>3<\/b> of 6 alerts/);
  const resolved = await renderAlertsAt("state=resolved", props);
  assert.equal([...resolved.matchAll(/class="al-row-link"/g)].length, 2, "a filter opens the group it picks");
  const viewer = await renderAlertsAt("", { ...props, canRespond: false, canMute: false });
  assert.doesNotMatch(viewer, /btn-primary/);
  // Ids stay in the record layer: none in the row text.
  const rows = html.replace(/<details[\s\S]*?<\/details>/g, "").replace(/(data-row-id|href|title|id|for|aria-labelledby)="[^"]*"/g, "");
  assert.doesNotMatch(rows, GUID);
});
