import assert from "node:assert/strict";
import { test } from "node:test";
import { leftOutWords } from "@/lib/compliance-view";

// A minor kind Microsoft kept failing on is left out of a new baseline (#666). The
// approved setup says so in plain words, beside an amber "Left out" chip.

const capture = {
  basis: "source-snapshot" as const, capturedAt: "2026-10-29T08:00:00Z", ageMs: 3_600_000, sourceSnapshotId: "s1",
  window: null, types: ["conditionalAccessPolicy", "group"], leftOut: [{ type: "todoSettings", reason: "microsoft-service-error" }],
};

test("the left-out kinds read as plain words, never as codes", () => {
  const words = leftOutWords(capture) ?? "";
  assert.match(words, /^Microsoft To Do setting is not in this setup: Microsoft kept answering with an error/);
  assert.doesNotMatch(words, /todoSettings/);
  assert.equal(leftOutWords({ ...capture, leftOut: [] }), null);
  assert.equal(leftOutWords({ ...capture, leftOut: undefined }), null, "an older baseline left nothing out");
  assert.match(leftOutWords({ ...capture, leftOut: [{ type: "todoSettings", reason: "x" }, { type: "formsSettings", reason: "x" }] }) ?? "", / and .* are not in this setup/);
});
