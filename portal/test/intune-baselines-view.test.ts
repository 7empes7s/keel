import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OTHER_CATEGORY, baselinesStatus, baselinesVerdict, foundLine, shapeBaselines, totalCounts, valueWords,
  type EngineBaselineResults,
} from "@/lib/intune-baselines-view";

const RTM = "device_vendor_msft_policy_config_defender_allowrealtimemonitoring";
const counts = (values: Partial<Record<string, number>>) => ({ conflict: 0, different: 0, "not-configured": 0, unknown: 0, match: 0, ...values });

const ENGINE: EngineBaselineResults = {
  templates: { readAt: "2026-10-30T10:00:00.000Z", outcome: "complete", error: null, failures: [] },
  lastFailure: null,
  policies: { snapshotId: "41", readAt: "2026-10-30T09:00:00.000Z", count: 3 },
  baselines: [
    { templateId: "old", name: "Windows baseline", version: "Version 23H2", state: "superseded", platforms: "windows10", counts: counts({ match: 1 }), settings: [
      { id: RTM, name: "Allow realtime monitoring", category: "Defender", expected: [`${RTM}_1`], labels: { [`${RTM}_1`]: "Allowed" }, result: "match", setBy: [{ policyName: "KEEL-RT-av", values: [`${RTM}_1`] }] },
    ] },
    { templateId: "new", name: "Windows baseline", version: "Version 24H2", state: "active", platforms: "windows10", counts: counts({ different: 1, conflict: 1, "not-configured": 1 }), settings: [
      { id: RTM, name: "Allow realtime monitoring", category: "Defender", expected: [`${RTM}_1`], labels: { [`${RTM}_0`]: "Not allowed", [`${RTM}_1`]: "Allowed" }, result: "different", setBy: [{ policyName: "KEEL-RT-av", values: [`${RTM}_0`] }] },
      { id: "cpu", name: "Average CPU load factor", category: null, expected: ["50"], labels: {}, result: "conflict", setBy: [{ policyName: "A", values: ["30"] }, { policyName: null, values: ["50"] }] },
      { id: "guest", name: "Insecure guest logons", category: "Network", expected: null, labels: {}, result: "not-configured", setBy: [] },
    ] },
    { templateId: "edge", name: "Edge baseline", version: null, state: "active", platforms: "windows10", counts: counts({ match: 0 }), settings: [] },
  ],
};

test("values read as words, never as option ids", () => {
  assert.equal(valueWords(RTM, `${RTM}_1`, { [`${RTM}_1`]: "Allowed" }), "Allowed");
  assert.equal(valueWords(RTM, `${RTM}_block_all`, {}), "block all");
  assert.equal(valueWords(RTM, "50", {}), "50");
});

test("results are shaped for the page: words, categories, baselines in order", () => {
  const data = shapeBaselines(ENGINE, "2026-10-30T12:00:00.000Z");
  assert.deepEqual(data.baselines.map((baseline) => [baseline.name, baseline.version, baseline.current]), [
    ["Edge baseline", null, true], ["Windows baseline", "Version 24H2", true], ["Windows baseline", "Version 23H2", false],
  ]);
  const current = data.baselines[1];
  const [rtm, cpu, guest] = current.settings;
  assert.equal(rtm.expected, "Allowed");
  assert.deepEqual(rtm.setBy, [{ policyName: "KEEL-RT-av", value: "Not allowed" }]);
  assert.equal(foundLine(rtm), "Yours: Not allowed (KEEL-RT-av)");
  assert.equal(cpu.category, OTHER_CATEGORY);
  assert.equal(cpu.setBy[1].policyName, "A policy with no name");
  assert.equal(foundLine(cpu), "2 policies disagree");
  assert.equal(guest.expected, null);
  assert.equal(foundLine(guest), "No settings catalog policy sets it");
  assert.equal(rtm.key, "new:" + RTM);
  // The same setting in two versions is two rows.
  assert.notEqual(data.baselines[2].settings[0].key, rtm.key);
});

test("the verdict leads with what differs, and says when nothing could be checked", () => {
  const data = shapeBaselines(ENGINE, "2026-10-30T12:00:00.000Z");
  const current = data.baselines.filter((baseline) => baseline.current);
  assert.deepEqual(totalCounts(current), counts({ different: 1, conflict: 1, "not-configured": 1 }));
  const verdict = baselinesVerdict(data, current);
  assert.equal(verdict.tone, "urgent");
  assert.equal(verdict.text, "2 settings differ from Microsoft's security baselines.");
  assert.match(verdict.detail, /1 set to different values by two or more policies/);
  assert.deepEqual(baselinesStatus(data), { tone: "urgent", label: "2 differ" });

  const unread = shapeBaselines({ ...ENGINE, policies: null }, "2026-10-30T12:00:00.000Z");
  assert.equal(baselinesVerdict(unread, unread.baselines).tone, "neutral");
  assert.match(baselinesVerdict(unread, unread.baselines).detail, /Run a backup of Intune settings/);
  assert.equal(baselinesStatus(unread), undefined);

  const never = shapeBaselines({ ...ENGINE, templates: null, baselines: [] }, "2026-10-30T12:00:00.000Z");
  assert.equal(baselinesVerdict(never, []).text, "Microsoft's security baselines have not been read yet.");
});
