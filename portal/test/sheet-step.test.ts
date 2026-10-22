import assert from "node:assert/strict";
import test from "node:test";

import { compareItemLine } from "@/lib/compare-view";
import { sheetStep, stepWords } from "@/lib/sheet-step";

test("the panel steps through the list it was opened from and stops at the ends", () => {
  assert.deepEqual(sheetStep(["a", "b", "c"], "a"), { index: 0, total: 3, previous: null, next: "b" });
  assert.deepEqual(sheetStep(["a", "b", "c"], "b"), { index: 1, total: 3, previous: "a", next: "c" });
  assert.deepEqual(sheetStep(["a", "b", "c"], "c"), { index: 2, total: 3, previous: "b", next: null });
  assert.equal(stepWords({ index: 1, total: 1200 }), "2 of 1,200");
});

test("no stepper for an item filtered out of the list, or a list of one", () => {
  assert.equal(sheetStep(["a", "b"], "z"), null);
  assert.equal(sheetStep(["a"], "a"), null);
  assert.equal(sheetStep(["a", "b"], null), null);
});

test("a changed item on Compare reads as one line: how many settings differ and which", () => {
  assert.equal(compareItemLine([{ path: "securityEnabled" }], 1), "1 setting differs: Security enabled.");
  assert.equal(compareItemLine([{ path: "state" }, { path: "displayName" }]), "2 settings differ: State and Display name.");
  assert.equal(compareItemLine([{ path: "state" }, { path: "displayName" }, { path: "description" }], 9), "9 settings differ: State, Display name and 7 more.");
  assert.equal(compareItemLine([], 0), "Only settings Microsoft sets itself differ.");
});
