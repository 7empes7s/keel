import assert from "node:assert/strict";
import { test } from "node:test";

import { deadlineSentence, deadlineWords, type AlertItem } from "@/lib/alerts-view";
import type { ApprovalRequestRecord } from "@/lib/approval-inbox";
import { approvalCounts, approvalsStatus, approvalsVerdict, expiryTone, impactBadge, requestTone } from "@/lib/approval-view";
import { backupFailureSeverity, failedNeedingFix } from "@/lib/backup-failure";
import { menuStatuses } from "@/lib/menu-status";
import { backupLine, backupsTone, firstCheckNote } from "@/lib/overview-view";
import { fillDriftTrend } from "@/lib/portal-data";
import { ACK_TARGET_HOURS, APPROVAL_URGENT_HOURS, approvalSeverity, failedSeverity, SEVERITY_RULES } from "@/lib/severity";
import type { CoverageSummary, CoverageType, DashboardData } from "@/lib/types";

// UI audit 31 Oct, E1 to E3: 99 of 100 approvals were Urgent, Critical alerts showed
// "No deadline", 4 of 8 services were red, the 30-day chart spiked to 981 on the day a
// new approved setup was approved, and "Last backup · Finished" was green beside a red
// "2 failed". Red now means one thing everywhere (lib/severity.ts).

const NOW = "2026-10-31T12:00:00.000Z";
const inHours = (hours: number) => new Date(Date.parse(NOW) + hours * 3_600_000).toISOString();

function request(over: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    id: "req-1", action: "remediate", params: {}, requestedBy: "someone-else", justification: null, status: "pending",
    decidedBy: null, decidedAt: null, reason: null, createdAt: inHours(-2), expiresAt: inHours(22), ...over,
  };
}

const lockout = (over: Partial<ApprovalRequestRecord> = {}) => request({
  references: { changes: [{ blastRadius: "cosmetic" }, { blastRadius: "tenant-lockout" }] } as never, ...over,
});

test("every level has one written rule", () => {
  assert.deepEqual(Object.keys(SEVERITY_RULES), ["urgent", "soon", "low", "fine"]);
  for (const rule of Object.values(SEVERITY_RULES)) assert.ok(rule.length > 10);
});

test("E1 approvals: a waiting request is red only in its last hour, whatever it would change", () => {
  assert.equal(APPROVAL_URGENT_HOURS, 1);
  assert.equal(approvalSeverity(22), "soon");
  assert.equal(approvalSeverity(3), "soon");
  assert.equal(approvalSeverity(0.5), "urgent");
  assert.equal(approvalSeverity(-1), "soon", "a lapsed request is not an emergency");
  assert.equal(approvalSeverity(null), "soon");

  // The audit's case: a request that would undo a change that could lock out admins.
  assert.equal(requestTone(lockout(), NOW), "soon");
  assert.deepEqual(impactBadge(lockout()), { tone: "soon", label: "Could lock out admins", icon: "alert" });
  assert.equal(requestTone(lockout({ expiresAt: inHours(3) }), NOW), "soon");
  assert.equal(requestTone(lockout({ expiresAt: inHours(0.5) }), NOW), "urgent");
  // An approved-setup switch with nothing risky stays low; a decided one is fine.
  assert.equal(requestTone(request({ action: "baseline-activate" }), NOW), "low");
  assert.equal(requestTone(request({ status: "approved" }), NOW), "fine");

  // The expiry badge: red in the last hour, amber within 4 hours, plain otherwise or once lapsed.
  assert.equal(expiryTone(request({ expiresAt: inHours(0.5) }), NOW), "urgent");
  assert.equal(expiryTone(request({ expiresAt: inHours(3) }), NOW), "soon");
  assert.equal(expiryTone(request({ expiresAt: inHours(22) }), NOW), "neutral");
  assert.equal(expiryTone(request({ expiresAt: inHours(-2) }), NOW), "neutral");
});

test("E1 approvals: 100 waiting, one lapsing within the hour, makes one red row and an amber page", () => {
  const pending = Array.from({ length: 100 }, (_, index) => lockout({ id: `req-${index}`, expiresAt: index === 0 ? inHours(0.5) : index < 10 ? inHours(3) : inHours(20) }));
  assert.equal(pending.filter((item) => requestTone(item, NOW) === "urgent").length, 1);
  const counts = approvalCounts({ pending, awaitingContentEffects: [], history: [] }, NOW);
  assert.equal(counts.expiringSoon, 10);
  assert.equal(counts.expiringNow, 1);
  assert.equal(approvalsStatus(counts).tone, "urgent");
  const calm = approvalCounts({ pending: pending.slice(1), awaitingContentEffects: [], history: [] }, NOW);
  assert.equal(calm.expiringNow, 0);
  assert.equal(approvalsStatus(calm).tone, "soon");
  assert.equal(approvalsVerdict(calm, pending[1], NOW).tone, "soon");
});

const alert = (over: Partial<AlertItem>): AlertItem => ({
  id: "a1e70000-0000-4000-8000-000000000001", resourceKey: "group:Finance", name: "Finance", control: "baseline", condition: "drift",
  state: "open", conditionActive: true, severity: "critical", occurrence: 1, firstOpenedAt: NOW,
  occurrenceStartedAt: NOW, lastFiringAt: NOW, ackDeadlineAt: null,
  acknowledgedAt: null, acknowledgedByName: null, owner: null, escalated: false, escalationError: null,
  cause: { changeType: "modified", resourceType: "group", snapshotId: null }, lastEventId: "drift:1", history: [], ...over,
});

test("E1 alerts: a Critical alert nobody is chasing is flagged as a gap, not shown as calm", () => {
  assert.deepEqual(deadlineWords(alert({}), NOW), { text: "No deadline set", tone: "soon" });
  assert.deepEqual(deadlineWords(alert({ severity: "warning" }), NOW), { text: "No deadline", tone: null });
  const sentence = deadlineSentence(alert({}), NOW, () => "", () => "")!;
  assert.match(sentence, new RegExp(`within ${ACK_TARGET_HOURS.critical} hours`));
  assert.match(sentence, /Settings, Notifications/);
  assert.equal(deadlineSentence(alert({ severity: "notice" }), NOW, () => "", () => ""), "No acknowledgement deadline is set for alerts like this one.");
});

function kind(type: string, extra: Partial<CoverageType> = {}): CoverageType {
  return {
    type, reportStatus: "covered", protectionState: "protected", stale: false, itemCount: 3, lastCollectedAt: NOW, adapter: `graph/${type}`,
    outcome: "complete", detail: null, fidelity: { declared: "read-only", measured: null, verifiedAt: null }, criticality: "tier1", blastRadius: null, remappable: null,
    ...extra,
  };
}

test("E1 backups: a failure is red only when a person must fix it", () => {
  const busy = kind("exchange-mail-flow", { outcome: "failed", detail: { httpStatus: 503, graphCode: null, message: "Service Unavailable" } as CoverageType["detail"] });
  const refused = kind("group", { outcome: "failed", diagnosis: { diagnosis: "missing-scope", original: { httpStatus: 403, graphCode: "Authorization_RequestDenied" } } });
  const partial = kind("teams-org-policies", { outcome: "partial" });
  assert.equal(backupFailureSeverity(busy), "soon");
  assert.equal(backupFailureSeverity(refused), "urgent");
  assert.equal(backupFailureSeverity(partial), "soon");
  assert.equal(backupFailureSeverity(kind("user")), null);
  assert.equal(failedNeedingFix([busy, refused, partial, kind("user")]), 1);
  assert.equal(failedSeverity(2, 0), "soon");
  assert.equal(failedSeverity(2, 1), "urgent");
  assert.equal(failedSeverity(2, undefined), "urgent", "unknown counts as needing a fix");
  assert.equal(failedSeverity(0, 0), null);
});

const coverage = (over: Partial<CoverageSummary> = {}): CoverageSummary => ({
  covered: 190, failed: 0, partial: 0, stale: 0, neverCollected: 0, notCovered: 5, unavailable: 1, total: 196, ...over,
});

test("E3 the last-backup card takes the Backups tile's colour and says what failed", () => {
  const base = { lastCollection: { id: "s1", status: "complete", startedAt: NOW, completedAt: NOW }, lastCompletedCollectionAt: inHours(-0.6), generatedAt: NOW } as unknown as Pick<DashboardData, "lastCollection" | "lastCompletedCollectionAt" | "generatedAt">;
  assert.deepEqual(backupLine({ ...base, coverage: coverage() }).state, { tone: "fine", label: "Finished" });
  // The audit's case: Microsoft errors Keel retries: amber on both.
  const retrying = coverage({ failed: 2, failedNeedsFix: 0 });
  assert.deepEqual(backupLine({ ...base, coverage: retrying }).state, { tone: "soon", label: "Finished · 2 failed kinds" });
  assert.equal(backupsTone(retrying), "soon");
  // A missing permission: red on both.
  const broken = coverage({ failed: 2, failedNeedsFix: 1 });
  assert.deepEqual(backupLine({ ...base, coverage: broken }).state, { tone: "urgent", label: "Finished · 2 failed kinds" });
  assert.equal(backupsTone(broken), "urgent");
  assert.deepEqual(backupLine({ ...base, coverage: coverage({ partial: 1 }) }).state, { tone: "soon", label: "Finished · 1 kind partly done" });
  assert.equal(backupsTone(coverage({ stale: 1 })), "soon");
  assert.equal(backupsTone(coverage()), undefined);
});

test("E1 the menu's Backup badge follows the same rule", () => {
  const data = { coverage: coverage({ failed: 2, failedNeedsFix: 0 }), openDriftByBlastRadius: [], openDriftTotal: 0, evidence: null, waiting: null } as unknown as Parameters<typeof menuStatuses>[0];
  assert.equal(menuStatuses(data).Backup?.tone, "soon");
  assert.equal(menuStatuses({ ...data, coverage: coverage({ failed: 2, failedNeedsFix: 2 }) }).Backup?.tone, "urgent");
  assert.equal(menuStatuses({ ...data, coverage: coverage({ failed: 2 }) }).Backup?.tone, "urgent");
});

test("E2 the first check after a new approved setup is marked, not drawn as a spike", () => {
  const trend = fillDriftTrend([
    { day: "2026-10-30", count: 3, firstCheck: 981 },
    { day: "2026-10-31", count: 5, firstCheck: 0 },
  ], new Date(NOW));
  assert.deepEqual(trend.at(-2), { day: "2026-10-30", count: 3, firstCheck: 981 });
  assert.deepEqual(trend.at(-1), { day: "2026-10-31", count: 5 }, "no firstCheck key on other days");
  const note = firstCheckNote(trend)!;
  assert.equal(note.day, "2026-10-30");
  assert.equal(note.count, 981);
  assert.equal(note.index, trend.length - 2);
  assert.equal(note.text, "New approved setup on 30 Oct: its first check found 981 settings that already differed. They are not counted as new changes.");
  assert.equal(Math.max(...trend.map((point) => point.count)), 5, "the line's scale ignores the first check");
  assert.equal(firstCheckNote(fillDriftTrend([{ day: "2026-10-31", count: 2 }], new Date(NOW))), null);
});
