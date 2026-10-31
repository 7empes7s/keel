import "./next-async-storage";
import assert from "node:assert/strict";
import { test } from "node:test";

import { compareSettings } from "@/lib/change-comparison";
import { readableTransitions } from "@/lib/change-intents";
import { shownTransitions } from "@/lib/change-intents-view";
import { readableValue, valueText } from "@/lib/changed-values";
import { HIDDEN_VALUE, HIDDEN_WORDS, valueWords } from "@/lib/changes-view";
import { diffPayloads } from "@/lib/drift-diff";

// UI audit 2026-10-31, B4: every diff view (Changes, Compare, Activity, Emergency
// changes, Approvals) leaves out null-vs-empty and order-only differences and never
// shows a password hint.

const CREDS_BEFORE = [{ keyId: "k1", hint: "U4i", displayName: "one" }, { keyId: "k2", hint: "68t", displayName: "two" }];
const CREDS_AFTER = [CREDS_BEFORE[1], CREDS_BEFORE[0]];

test("Approvals: null against empty and a reordered list are not changes; hints are hidden", () => {
  assert.deepEqual(diffPayloads({ description: null, passwordCredentials: CREDS_BEFORE }, { description: "", passwordCredentials: CREDS_AFTER }), []);
  assert.deepEqual(diffPayloads({ state: "on" }, { state: "on", description: "" }), []);
  const changes = diffPayloads({ passwordCredentials: [CREDS_BEFORE[0]] }, { passwordCredentials: CREDS_BEFORE });
  assert.equal(changes.length, 1);
  assert.equal(JSON.stringify(changes).includes("U4i") || JSON.stringify(changes).includes("68t"), false);
});

test("Changes comparison: no 'Not set -> not set' rows and no hints", () => {
  const comparison = compareSettings(
    { displayName: "KEEL-RT-app", description: null, passwordCredentials: CREDS_BEFORE },
    { displayName: "KEEL-RT-app", description: "", notes: "", passwordCredentials: CREDS_AFTER },
  );
  assert.equal(comparison.differing, 0);
  assert.equal(comparison.rows.some((row) => row.path === "notes"), false);
  const added = compareSettings({ passwordCredentials: [CREDS_BEFORE[0]] }, { passwordCredentials: CREDS_BEFORE });
  assert.equal(added.differing, 1);
  const text = JSON.stringify(added.rows);
  assert.equal(text.includes("U4i") || text.includes("68t"), false, text);
});

test("Emergency changes: no-change transitions are flagged and left out; hints are hidden", () => {
  const transitions = readableTransitions([
    { field: "description", before: { present: true, value: null }, after: { present: true, value: "" } },
    { field: "notes", before: { present: false, value: null }, after: { present: true, value: "" } },
    { field: "tags", before: { present: true, value: ["a", "b"] }, after: { present: true, value: ["b", "a"] } },
    { field: "passwordCredentials", before: { present: true, value: [CREDS_BEFORE[0]] }, after: { present: true, value: CREDS_BEFORE } },
  ]);
  assert.deepEqual(shownTransitions(transitions).map((transition) => transition.field), ["passwordCredentials"]);
  assert.deepEqual(transitions.map((transition) => transition.noChange), [true, true, true, false]);
  const text = JSON.stringify(transitions);
  assert.equal(text.includes("U4i") || text.includes("68t"), false, text);
});

test("a hidden value reads in plain words", () => {
  assert.equal(valueWords(HIDDEN_VALUE), HIDDEN_WORDS);
  assert.equal(readableValue(HIDDEN_VALUE), HIDDEN_WORDS);
  assert.ok(valueText({ hint: HIDDEN_VALUE }).includes(HIDDEN_WORDS));
});
