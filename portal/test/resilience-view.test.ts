import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeFreshness, computeRecoverablePoint, computeRecoveryTime, typeDependency,
} from "../../engine/coverage/recoveryMetrics.mjs";
import { summarizeRecoveryReadiness } from "../../engine/coverage/recoveryReadiness.mjs";
import {
  attemptReason, cadenceSentence, dependencyName, formatDuration, freshnessSentence, offsiteReason,
  recoverablePointSentence, recoveryTimeSentence, resilienceVerdict, type RecoveryMetrics,
} from "@/lib/resilience-view";

// Roadmap task-73: the Resilience page's words, fed by the engine's own computations
// (engine/coverage/recoveryMetrics.mjs) so the view reads the shapes the reader returns.

const NOW = "2026-10-03T12:00:00.000Z";
const TENANT = "sha256:portal-resilience";
const required = [typeDependency("user"), typeDependency("group")];

function metrics({ observations = [], copies = [], drills = [], restores = [], observationsById = new Map() }: {
  observations?: unknown[]; copies?: unknown[]; drills?: unknown[]; restores?: unknown[]; observationsById?: Map<string, unknown>;
} = {}): RecoveryMetrics {
  return {
    version: 1,
    tenantRef: TENANT,
    generatedAt: NOW,
    freshness: computeFreshness({ required, observations, now: NOW }),
    recoverablePoint: computeRecoverablePoint({ required, copies, observationsById, relationshipsBySnapshot: new Map(), tenantRef: TENANT, now: NOW }),
    recoveryTime: computeRecoveryTime({ drills: drills as never[], restores: restores as never[], tenantRef: TENANT }),
    readiness: summarizeRecoveryReadiness(drills, { tenantRef: TENANT }),
    configured: { cadence: [{ id: "s1", jobKind: "collect", tier: "tier1", cadence: { every: "hour", n: 1, atTime: null }, cron: null, enabled: true }], objectives: null },
  } as RecoveryMetrics;
}

const success = (type: string, startedAt: string, snapshotId = "s-1") => ({
  dependency: `type:${type}`, observationId: `${snapshotId}:${type}`, snapshotId, outcome: "complete", success: true, startedAt, completedAt: startedAt,
});

function drill(outcome: string, elapsedMs: number, startedAt: string) {
  const finishedAt = new Date(new Date(startedAt).getTime() + elapsedMs).toISOString();
  return {
    tenant_ref: TENANT, occurred_at: finishedAt, seq: 1,
    subject: { tenantRef: TENANT, mode: "live", scope: "bounded-same-tenant", outcome, startedAt, finishedAt, elapsedMs,
      elapsedSource: "observed-clock", bounds: { maxElapsedMs: 1_800_000 }, cleanup: { status: "complete" }, objects: [] },
  };
}

test("no samples is said to be unmeasured, never good, never zero, never the schedule", () => {
  const empty = metrics();
  const verdict = resilienceVerdict(empty, NOW);
  assert.equal(verdict.tone, "attention");
  assert.match(verdict.text, /not measured/);
  assert.equal(verdict.headline, "Recovery point not measured");
  assert.ok(verdict.text.split(/\s+/).length <= 25);
  assert.match(freshnessSentence(empty), /^Not measured/);
  assert.match(recoverablePointSentence(empty, NOW), /^Not measured/);
  assert.match(recoveryTimeSentence(empty), /^Not measured/);
  for (const sentence of [verdict.text, freshnessSentence(empty), recoveryTimeSentence(empty)]) {
    assert.doesNotMatch(sentence, /\b0 (minutes|hours)\b|every hour/);
  }
  assert.equal(formatDuration(null), "not measured");
  // The plan is described as a plan, apart from the measurements.
  assert.equal(cadenceSentence(empty.configured.cadence[0]), "Tier 1 backup: every hour");
});

test("a measured point with no timed recovery still says recovery time is not measured", () => {
  const observations = [success("user", "2026-10-03T06:00:00.000Z"), success("group", "2026-10-03T06:00:00.000Z")];
  const observationsById = new Map(observations.map((observation) => [observation.observationId, observation]));
  const copies = [{ seq: "9", at: "2026-10-03T07:00:00Z", subject: {
    tenantRef: TENANT, verification: { ok: true }, dumpSha256: "a".repeat(64), remoteSha256: "a".repeat(64),
    shippedAt: "2026-10-03T07:00:00Z", observationIds: ["s-1:user", "s-1:group"],
  } }];
  let current = metrics({ observations, observationsById, copies });
  let verdict = resilienceVerdict(current, NOW);
  assert.equal(verdict.tone, "attention");
  assert.equal(verdict.text, "If this server were lost, KEEL could recover settings as of 6 hours ago. Recovery time is not measured yet.");
  assert.equal(freshnessSentence(current), "The oldest good backup KEEL relies on is 6 hours old: User.");

  // A failed drill changes nothing; a passed one is the number the verdict repeats.
  current = metrics({ observations, observationsById, copies, drills: [drill("failed", 60_000, "2026-10-03T08:00:00.000Z")] });
  assert.equal(resilienceVerdict(current, NOW).tone, "attention");
  assert.equal(attemptReason(current.recoveryTime.attempts[0]), "it failed");
  current = metrics({ observations, observationsById, copies, drills: [drill("passed", 8 * 60_000, "2026-10-03T08:00:00.000Z")] });
  verdict = resilienceVerdict(current, NOW);
  assert.equal(verdict.tone, "good");
  assert.equal(verdict.text, "If this server were lost, KEEL could recover settings as of 6 hours ago. The last proven recovery took 8 minutes.");
  assert.ok(verdict.text.split(/\s+/).length <= 25);
});

test("reasons and names are words, not codes", () => {
  assert.equal(dependencyName("relationship:group/members"), "Members of each group");
  assert.equal(dependencyName("type:conditionalAccessPolicy"), "Conditional Access policy");
  const copy = { recordedAt: null, shippedAt: null, dumpSha256: null, manifestGeneratedAt: null, seq: "1", counts: false, point: null };
  assert.equal(offsiteReason({ ...copy, reason: "missing-required-observation", missing: ["type:group", "relationship:group/members"] }),
    "it holds no good backup of Group and Members of each group");
  assert.equal(offsiteReason({ ...copy, reason: "remote-checksum-mismatch", missing: [] }), "the copy on the off-site host did not match the original");
  assert.equal(formatDuration(125 * 60_000), "2 hours 5 minutes");
  const gaps = metrics({ observations: [success("user", "2026-10-03T06:00:00.000Z")] });
  assert.equal(gaps.freshness.state, "gaps");
  assert.equal(freshnessSentence(gaps), "Not measured: 1 required item has never been backed up successfully.");
});
