import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeFreshness, computeRecoverablePoint, computeRecoveryTime, typeDependency,
} from "../../engine/coverage/recoveryMetrics.mjs";
import { summarizeRecoveryReadiness } from "../../engine/coverage/recoveryReadiness.mjs";
import {
  attemptReason, cadenceSentence, dependencyName, formatDuration, freshnessSentence, notUsedSentence, offsiteReason,
  recoverablePointSentence, recoveryTimeSentence, resilienceAlerts, resilienceVerdict, serviceGroups, serviceState,
  resilienceKinds, type RecoveryMetrics, type ResilienceData, type ServiceBackup,
} from "@/lib/resilience-view";
import { coverageBuckets, protectCounts } from "@/lib/protect-view";
import type { CoverageType } from "@/lib/types";

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

// A kind as the coverage report gives it; by default backed up in full an hour ago.
function kind(type: string, extra: Partial<CoverageType> = {}): CoverageType {
  return {
    type, reportStatus: "covered", protectionState: "protected", stale: false, itemCount: 3, lastCollectedAt: "2026-10-03T11:00:00.000Z",
    adapter: `graph-${type}`, outcome: "complete", fidelity: { declared: "full", measured: null, verifiedAt: null }, ...extra,
  } as CoverageType;
}

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
  assert.equal(cadenceSentence(empty.configured.cadence[0]), "Critical settings (tier 1): every hour");
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
  assert.equal(freshnessSentence(gaps), "Not measured: 1 item has no good backup yet.");
});

test("a service backup failure is reported once, by its service, never against Entra ID and Intune", () => {
  const NOW_ = "2026-10-03T12:00:00.000Z";
  const base = metrics({ observations: [success("user", "2026-10-03T06:00:00.000Z"), success("group", "2026-10-03T06:00:00.000Z")] });
  const mail: ServiceBackup = {
    kind: "content", workload: "exchange-mail", name: "Mail, calendars and contacts", service: "Exchange", switchedOn: true,
    latest: { id: "c1", outcome: "failed", at: "2026-10-03T01:00:00.000Z" }, lastGood: null, stored: null,
  };
  const data: ResilienceData = {
    generatedAt: NOW_,
    metrics: {
      ...base,
      // The engine puts every service backup into freshness as well.
      freshness: { ...base.freshness, state: "gaps", gaps: [{ key: "content:exchange-mail", kind: "content", type: null, parentType: null, family: null, workload: "exchange-mail", lastAttempt: { at: "2026-10-03T01:00:00.000Z", outcome: "failed" } }] },
      services: { settings: [], content: [mail] },
    },
    kinds: resilienceKinds([kind("user"), kind("group")]),
    incidents: [],
    storage: { configured: true, provider: "local-disk", region: null, boundary: null, immutability: "live-qualified", generatedAt: null, certifies: null, source: null },
  } as ResilienceData;
  const alerts = resilienceAlerts(data);
  assert.equal(alerts.some((alert) => alert.key === "kinds-failed" || alert.key === "kinds-late"), false);
  assert.equal(alerts.filter((alert) => alert.key === "service-never-worked").length, 1);
  const [entra] = serviceGroups(data.metrics, data.kinds, NOW_);
  assert.equal(entra.rows[0].status, "Backed up");
});

test("a workload whose latest run was switched off reads as switched off, not failed", () => {
  const off: ServiceBackup = {
    kind: "service-settings", workload: "teams-org-policies", name: "Teams organization policy", service: "Teams", switchedOn: true,
    latest: { id: "w2", outcome: "disabled", at: "2026-10-03T02:00:00.000Z" },
    lastGood: { id: "w1", from: "2026-10-02T02:00:00.000Z", at: "2026-10-02T02:05:00.000Z", settings: 9 },
  };
  assert.deepEqual(serviceState(off, NOW), { tone: "neutral", status: "Switched off" });
  assert.deepEqual(serviceState({ ...off, lastGood: null }, NOW), { tone: "neutral", status: "Switched off" });
});

test("a type the tenant does not use is listed as not used, not as never backed up", () => {
  const unavailable = {
    dependency: "type:lifecycleWorkflow", observationId: "s-1:lifecycleWorkflow", snapshotId: "s-1", outcome: "unavailable", success: false,
    startedAt: "2026-10-03T11:00:00.000Z", completedAt: "2026-10-03T11:00:00.000Z",
  };
  const freshness = computeFreshness({
    required: [...required, typeDependency("lifecycleWorkflow")],
    observations: [success("user", "2026-10-03T11:00:00.000Z"), success("group", "2026-10-03T10:00:00.000Z"), unavailable],
    now: NOW,
  });
  assert.equal(freshness.state, "measured");
  assert.equal(freshness.gaps.length, 0);
  assert.equal(freshness.required, 2);
  const view = { ...metrics(), freshness } as RecoveryMetrics;
  assert.equal(notUsedSentence(view), "1 type is not used in this tenant, which has no licence or feature for it, so it is not counted:");
  assert.equal(dependencyName(freshness.notUsed[0]), "Lifecycle workflow");
  assert.equal(notUsedSentence(metrics()), null);
});

// Audit 31 Oct 2026: Resilience said "N never backed up" from recovery freshness (no good
// copy ever) while What's protected and the Overview count kinds by backupHealth. A kind whose
// only read stopped part way is "failed" there, so Resilience must say failed too.
test("the Entra ID and Intune row and alerts count kinds with What's protected's buckets", () => {
  const types = [
    kind("user"),
    kind("group", { outcome: "partial", itemCount: 12 }),
    kind("authenticationMethodsPolicy", { protectionState: "failed", reportStatus: "failed", outcome: "failed", itemCount: 0, lastCollectedAt: null }),
    kind("deviceConfiguration", { stale: true, lastCollectedAt: "2026-09-20T11:00:00.000Z" }),
    kind("namedLocation", { reportStatus: "never-collected", outcome: "not-requested", lastCollectedAt: null, itemCount: null }),
    kind("managedDevice", { protectionState: "not-covered", reportStatus: "not-covered", adapter: null, outcome: null, lastCollectedAt: null }),
  ];
  const counts = protectCounts(types);
  assert.deepEqual([counts.failed, counts.stale, counts.never], [2, 1, 1]);
  // Freshness sees three items with no good copy; that is not the count the reader is shown.
  const base = metrics({ observations: [success("user", "2026-10-03T11:00:00.000Z")] });
  const data = { generatedAt: NOW, metrics: base, kinds: resilienceKinds(types), incidents: [], storage: { configured: false } } as unknown as ResilienceData;
  const { summary } = data.kinds;
  assert.deepEqual([summary.failed, summary.stale, summary.neverCollected, summary.covered, summary.total], [counts.failed, counts.stale, counts.never, counts.backedUp, counts.total]);
  const buckets = coverageBuckets(types);
  assert.equal(buckets.backedUp + buckets.failed + buckets.stale + buckets.never + buckets.notCollected + buckets.unavailable, buckets.total);

  const [entra] = serviceGroups(data.metrics, data.kinds, NOW);
  assert.equal(entra.rows[0].status, `${counts.failed} failed`);
  assert.equal(entra.rows[0].tone, "urgent");

  const alerts = resilienceAlerts(data);
  const failed = alerts.find((alert) => alert.key === "kinds-failed");
  assert.equal(failed?.title, `${counts.failed} Entra ID and Intune kinds failed their last backup`);
  assert.deepEqual(failed?.more, ["Authentication methods policy", "Group"]);
  assert.equal(failed?.action?.href, "/protect?health=failed");
  const late = alerts.find((alert) => alert.key === "kinds-late");
  assert.equal(late?.title, `${counts.stale + counts.never} Entra ID and Intune kinds are out of date or never backed up`);
  assert.equal(late?.action?.href, "/protect?health=out-of-date");
  // No Resilience line says "never backed up" with a count that differs from the buckets.
  for (const alert of alerts) assert.doesNotMatch(alert.title, new RegExp(`^${base.freshness.gaps.length} .*never backed up`));

  // Nothing failed, two late: the row says so in the same words as the Overview alert.
  const calmer = resilienceKinds(types.filter((item) => !["group", "authenticationMethodsPolicy"].includes(item.type)));
  const [row] = serviceGroups(base, calmer, NOW);
  assert.deepEqual([row.rows[0].status, row.rows[0].tone], ["2 out of date or never", "soon"]);
  // All backed up.
  assert.deepEqual(serviceGroups(base, resilienceKinds([kind("user")]), NOW)[0].rows[0].status, "Backed up");
});
