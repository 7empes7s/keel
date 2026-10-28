// The undo of a restore that created an Intune policy which is assigned now: the
// person chooses to delete the policy with its assignments, or to skip it.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseUndoChoices } from "@/lib/undo-choices";
import { assignmentReach, undoChoiceSentence } from "@/lib/undo-view";

test("undo choices are delete or skip per policy, and anything else is refused", () => {
  assert.equal(parseUndoChoices(undefined), null);
  assert.equal(parseUndoChoices(null), null);
  assert.equal(parseUndoChoices({}), null);
  assert.deepEqual(parseUndoChoices({ "deviceConfiguration:KEEL-RT-a": "delete", "configurationPolicy:KEEL-RT-b": "skip" }),
    { "deviceConfiguration:KEEL-RT-a": "delete", "configurationPolicy:KEEL-RT-b": "skip" });
  for (const bad of [[], "delete", 1, { "deviceConfiguration:KEEL-RT-a": "remove" }, { "": "skip" }, { "--enforce": "delete" },
    Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`k${index}`, "skip"]))]) {
    assert.equal(parseUndoChoices(bad), false, JSON.stringify(bad).slice(0, 60));
  }
});

test("who an assigned policy applies to reads as words", () => {
  assert.equal(assignmentReach([{ kind: "all-devices" }]), "All devices");
  assert.equal(assignmentReach([{ kind: "group" }, { kind: "group" }, { kind: "excluded-group" }]), "2 groups, 1 group left out");
  assert.equal(assignmentReach([{ kind: "all-users" }, { kind: "group" }, { kind: "other" }]), "All users, 1 group, 1 other target");
  assert.equal(assignmentReach([]), "");
});

test("each choice says what it does, in plain words", () => {
  assert.equal(undoChoiceSentence("delete", 2), "Removes its 2 assignments, then deletes the policy. Devices and people it applies to lose its settings.");
  assert.equal(undoChoiceSentence("skip", 1), "Keeps the policy and its 1 assignment as they are. Nothing is changed.");
});
