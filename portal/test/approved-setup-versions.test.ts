import assert from "node:assert/strict";
import { test } from "node:test";

import { captureBlockedWords, notHeldWords, putBackWords } from "@/lib/baselines-view";
import type { BaselineCapture, BaselineRecord } from "@/lib/types";

// Backlog B12 and D16 (UI audit, 31 Oct 2026): version 10 was "In use" yet read older
// than version 9 and held 62 kinds against 170, and "Capture new version" was off with
// no reason. The page now says the version is a put-back copy, and why capture is off.

const now = "2026-10-31T22:00:00Z";
const capture = (capturedAt: string, kinds: number): BaselineCapture => ({
  basis: "source-snapshot", capturedAt, ageMs: Date.parse(now) - Date.parse(capturedAt), sourceSnapshotId: `s-${capturedAt}`,
  window: null, types: Array.from({ length: kinds }, (_, index) => `kind${index}`),
});
const version = (id: string, n: number, setAt: string, captured: BaselineCapture, extra: Partial<BaselineRecord> = {}): BaselineRecord => ({
  id, label: "Golden", description: null, setAt, setBy: "p1", active: false, resourceCount: 100, version: n, capture: captured, ...extra,
});
const v3 = version("v3", 3, "2026-10-12T10:00:00Z", capture("2026-10-12T09:00:00Z", 62));
const v9 = version("v9", 9, "2026-10-25T10:00:00Z", capture("2026-10-25T09:00:00Z", 170), { supersededById: "v10" });
const v10 = version("v10", 10, "2026-10-30T18:00:00Z", v3.capture!, { active: true, supersedesId: "v9", reinstatedFrom: { id: "v3", version: 3 } });

test("a put-back version says which version it copies, how old its settings are, and what it holds less of", () => {
  const words = putBackWords(v10, [v10, v9, v3], now) ?? "";
  assert.match(words, /^This version is a copy of version 3, put back 28 hours ago\./);
  assert.match(words, /holds the settings version 3 held, as they were 19 days ago: 62 setting types\./);
  assert.match(words, /Version 9, which it replaced, held 170 types, so 108 types are not checked until you capture a new version\.$/);
  assert.equal(putBackWords(v9, [v10, v9, v3], now), null, "a re-snapshot is not a put-back");
  // Holding as much as the version it replaced needs no warning.
  assert.doesNotMatch(putBackWords({ ...v10, capture: v9.capture }, [v10, v9], now) ?? "", /not checked/);
});

test("kinds Keel backs up that the setup does not hold are named", () => {
  assert.equal(notHeldWords(v3, ["kind0", "kind1"]), null);
  assert.match(notHeldWords(v3, ["kind0", "user", "group"]) ?? "", /^2 setting types Keel backs up now are not in it \(User, Group\)\. Capture a new version to add them\.$/);
});

test("a disabled Capture new version says what a complete backup needs and what the newest one missed", () => {
  const base = { capturedAt: v10.capture!.capturedAt, now, sources: [] };
  assert.match(captureBlockedWords({ ...base, gap: null, hasSource: true }), /^Capture new version: takes the setup/);
  const gap = { id: "s9", completedAt: "2026-10-31T20:00:00Z", notInBackup: Array.from({ length: 40 }, (_, index) => `k${index}`), partial: ["group"], failed: ["todoSettings"] };
  const words = captureBlockedWords({ ...base, gap, hasSource: false });
  assert.match(words, /^Capture new version needs a newer complete backup: one that read every setting type in full\./);
  assert.match(words, /The newest backup, finished 2 hours ago, was not complete: Microsoft To Do setting could not be read, Group was read only in part and 40 types were not part of it\.$/);
  assert.doesNotMatch(words, /todoSettings/, "kinds are named in words, never as codes");
  assert.match(captureBlockedWords({ ...base, gap: null, hasSource: false }), /No backup has finished yet\.$/);
  assert.match(captureBlockedWords({ ...base, gap: null, hasSource: false, sources: [{ completedAt: "2026-10-01T00:00:00Z" }] }),
    /None has finished since this version's settings were taken 19 days ago; the newest complete one finished 30 days ago\.$/);
});
