import assert from "node:assert/strict";
import { test } from "node:test";

import { alertCall } from "@/lib/alert-calls";
import { rowHref, rowHrefLabel, recordRow } from "@/lib/activity-view";
import {
  acknowledgeNote, alertCounts, alertsStatus, alertsVerdict, withLocalChanges, type AlertItem,
} from "@/lib/alerts-view";
import { evidenceSentence } from "@/lib/sentences";
import { renderAlertsAt } from "./render-alerts";

// UI audit 2026-10-31 (B5): after "Acknowledge" the banner said 196 while the header
// pill still said "197 waiting", the alert kept "No owner", and the note showed nowhere.
// Now the pill, banner and tiles count one list, the acknowledger is the owner, and the
// note is on the alert and in Activity.

const NOW = "2026-10-31T18:00:00Z";
const ME = { id: "8c1e0000-0000-4000-8000-0000000000b5", name: "Marouane Defili" };

const alert = (id: number, over: Partial<AlertItem> = {}): AlertItem => ({
  id: `b5000000-0000-4000-8000-00000000000${id}`, resourceKey: "group:KEEL-RT-Finance", name: "KEEL-RT-Finance", control: "baseline", condition: "drift",
  state: "open", conditionActive: true, severity: "warning", occurrence: 1, firstOpenedAt: "2026-10-31T17:00:00Z",
  occurrenceStartedAt: "2026-10-31T17:00:00Z", lastFiringAt: "2026-10-31T17:00:00Z", ackDeadlineAt: null,
  acknowledgedAt: null, acknowledgedByName: null, owner: null, escalated: false, escalationError: null,
  cause: { changeType: "modified", resourceType: "group", snapshotId: null }, lastEventId: "drift:1", history: [], ...over,
});
const ALERTS = [alert(1), alert(2), alert(3)];

test("an acknowledge made on the page moves the pill, the banner and the tiles together", () => {
  const before = alertCounts(ALERTS, NOW);
  assert.equal(alertsStatus(before).label, "3 waiting");
  const after = withLocalChanges(ALERTS, { [ALERTS[0].id]: { state: "acknowledged", owner: ME, note: "  KEEL-RT- on it ", at: NOW, by: "you" } });
  const counts = alertCounts(after, NOW);
  assert.equal(alertsStatus(counts).label, "2 waiting");
  assert.match(alertsVerdict(after, NOW).text, /^2 alerts need someone/);
  assert.equal(counts.acknowledged, 1);
  // The acknowledger owns it, and the note is on it.
  assert.deepEqual(after[0].owner, ME);
  assert.equal(after[0].acknowledgedByName, "you");
  assert.equal(acknowledgeNote(after[0]), "KEEL-RT- on it");
  assert.equal(after[0].history.at(-1)?.note, "KEEL-RT- on it");
  // Untouched alerts are the same objects.
  assert.equal(after[1], ALERTS[1]);
});

test("the note shown is this occurrence's: an earlier occurrence's note does not carry over", () => {
  const entry = (occurrence: number, note: string | null) => ({ id: String(occurrence), occurrence, fromState: "open" as const, toState: "acknowledged" as const, reason: "acknowledged", actor: ME.id, actorName: ME.name, at: NOW, eventId: null, note });
  assert.equal(acknowledgeNote(alert(4, { state: "acknowledged", occurrence: 2, history: [entry(1, "old"), entry(2, "new")] })), "new");
  assert.equal(acknowledgeNote(alert(4, { state: "acknowledged", occurrence: 2, history: [entry(1, "old")] })), null);
  assert.equal(acknowledgeNote(alert(4, { state: "open", history: [entry(1, "old")] })), null);
});

test("the header the body draws counts the same list as the banner", async () => {
  const html = await renderAlertsAt("", { alerts: ALERTS, now: NOW, canRespond: true, canMute: true, header: { description: "Alerts.", generatedAt: NOW } });
  assert.match(html, /class="status-pill"[^>]*>[\s\S]*?3 waiting<\/span>/);
  assert.match(html, /3 alerts need someone/);
  assert.equal([...html.matchAll(/<h1>Alerts<\/h1>/g)].length, 1);
});

test("the acknowledge call hands back who owns the alert now", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ alert: { id: "x", state: "acknowledged", owner: ME } })) as typeof fetch;
  try {
    assert.deepEqual(await alertCall(ALERTS[0].id, "acknowledge", "on it"), { ok: true, status: 200, state: "acknowledged", owner: ME });
  } finally {
    globalThis.fetch = original;
  }
});

test("Activity names the action, the alert and the note, and links to the alert", () => {
  const entry = { seq: "41", occurred_at: NOW, kind: "alert-action", actor: ME.id, prev_hash: null, record_hash: "h",
    subject: { action: "acknowledged", alertId: ALERTS[0].id, naturalKey: "group:KEEL-RT-Finance", note: "KEEL-RT- on it" } };
  const names = { "group:KEEL-RT-Finance": { name: "KEEL-RT-Finance", resourceType: "group" } };
  const sentence = evidenceSentence(entry, ME.name, names);
  assert.match(sentence, /^Marouane Defili acknowledged an alert about .*KEEL-RT-Finance.*: “KEEL-RT- on it”$/);
  assert.equal(evidenceSentence({ ...entry, subject: { action: "unmuted" } }, ME.name), "Marouane Defili unmuted an alert");
  const row = recordRow(entry as Parameters<typeof recordRow>[0], {}, names);
  assert.equal(row.kind, "other");
  assert.equal(rowHref(row), `/alerts?open=${ALERTS[0].id}`);
  assert.equal(rowHrefLabel(row), "Open the alert");
  // A long note is cut in the sentence; the full note stays on the alert.
  assert.ok(evidenceSentence({ ...entry, subject: { ...entry.subject, note: "x".repeat(400) } }, ME.name).length < 220);
});
