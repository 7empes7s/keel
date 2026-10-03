import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { CommandPalette } from "@/components/command-palette";
import { NavLinks } from "@/components/nav-links";
import { KeelMark } from "@/components/keel-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Toaster } from "@/components/toaster";
import { PageHeader } from "@/components/page-header";
import { JobTable } from "@/components/job-table";
import { JobRefresher } from "@/components/job-refresher";
import { PageSkeleton } from "@/components/ui/skeleton";
import { BackupControls } from "@/components/backup-controls";
import { ApprovalInbox } from "@/components/approval-inbox";
import { DeliveryTable, NotificationConsole } from "@/components/notification-console";
import { IntegrationConsole } from "@/components/integration-console";
import { ChainIndicator, EvidenceTimeline } from "@/components/evidence-timeline";
import { PrincipalDetails } from "@/components/principal-details";
import { KillSwitchBadge, PolicyState } from "@/components/policy-state";
import { usePathname } from "next/navigation";
import { RestoreSelection } from "@/components/restore-selection";
import { DriftTable } from "@/components/drift-table";
import { CoverageReport } from "@/components/coverage-report";
import { JobDetail } from "@/components/job-detail";
import { RecoveryCompletion } from "@/components/recovery-completion";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import type { DashboardData, DriftRecord } from "@/lib/types";

// UI harness: the real portal components with fixture data (see build.mjs).
// Each API the restore wizard calls gets a plausible answer after
// a short delay so the real component walks its real states.
const DEPENDS: Record<string, string[]> = {
  "conditionalAccessPolicy:Block legacy auth": ["group:Break-glass admins", "namedLocation:HQ egress"],
  "conditionalAccessPolicy:Require MFA for admins": ["group:Break-glass admins", "authenticationStrength:Phishing-resistant"],
  "deviceConfiguration:Windows baseline": ["group:All managed devices"],
};
let jobPolls = 0;
let lastClosure: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// Task-65: completion items for the recreated application of restore job r9.
const completionVerified = new Set<string>(["ci-4"]);
const completionItem = (id: string, kind: string, requirement: string, description: string) => ({
  id, kind, requirement, description, owner: "operator@contoso.example", reopenCount: 0,
  state: completionVerified.has(id) ? "verified" : "pending",
  evidence: completionVerified.has(id) ? [{ type: "ticket", reference: "CHG-4471" }] : [],
  closedAt: completionVerified.has(id) ? "2026-10-02T09:40:00Z" : null,
});
function completionResources() {
  const appItems = [
    completionItem("ci-1", "credential", "passwordCredentials", "Issue new client secrets and update every consumer that authenticates as this app"),
    completionItem("ci-2", "integration", "newObjectId", "A new object id was assigned: update every external system that referenced the old id"),
    completionItem("ci-3", "service-validation", "signIn", "Confirm a real sign-in or token request succeeds for the application"),
  ];
  const groupItems = [completionItem("ci-4", "integration", "newObjectId", "A new object id was assigned: update every external system that referenced the old id")];
  const stateOf = (items: { kind: string; state: string }[]) => {
    const open = items.filter((entry) => entry.state !== "verified");
    if (!open.length) return "verified-complete";
    return open.some((entry) => entry.kind !== "service-validation") ? "configuration-restored" : "service-validation-pending";
  };
  return [
    { naturalKey: "application:Payroll connector", resourceType: "application", mechanism: "recreate", state: stateOf(appItems), items: appItems },
    { naturalKey: "group:Finance approvers", resourceType: "group", mechanism: "recreate", state: stateOf(groupItems), items: groupItems },
  ];
}
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  await new Promise((resolve) => setTimeout(resolve, url.includes("/selection") || url.includes("/completion") ? 350 : 800));
  if (url.includes("/api/actions/restore/completion/")) return json({ restoreRef: "r9", resources: completionResources() });
  if (url.endsWith("/api/actions/restore/completion")) {
    const body = JSON.parse(String(init?.body)) as { itemId: string; action: string; evidence?: { reference: string } };
    if (body.action === "complete" && /secret|BEGIN/i.test(body.evidence?.reference ?? "")) {
      return json({ error: "invalid_evidence", message: "evidence looks like it contains a secret or key — store a reference to the proof, never the credential" }, 400);
    }
    if (body.action === "complete") completionVerified.add(body.itemId); else completionVerified.delete(body.itemId);
    return json({ changed: true });
  }
  if (url.endsWith("/api/actions/restore/selection")) {
    const { selected } = JSON.parse(String(init?.body)) as { selected: string[] };
    const added = new Map<string, { requiredBy: string; field: string }[]>();
    for (const key of selected) for (const dep of DEPENDS[key] ?? []) {
      if (!selected.includes(dep)) added.set(dep, [...(added.get(dep) ?? []), { requiredBy: key, field: dep.startsWith("group") ? "conditions.users.includeGroups" : "conditions.locations" }]);
    }
    const missing = [...new Set(Object.entries(DEPENDS).filter(([key]) => !selected.includes(key)).flatMap(() => []))];
    lastClosure = [...selected, ...added.keys()];
    return json({ selected, closureKeys: lastClosure, added: [...added].map(([naturalKey, reasons]) => ({ naturalKey, resourceType: naturalKey.split(":")[0], reasons })), unresolvedReferences: [], guardRefusals: [], missingRequirements: missing });
  }
  if (url.endsWith("/api/actions/restore/dry-run")) { jobPolls = 0; return json({ job: { id: "job-dry-7f3c" }, artifactId: "dr-7f3c" }, 202); }
  if (url.includes("/api/jobs/")) { jobPolls += 1; return json({ job: { status: jobPolls >= 2 ? "succeeded" : "running" } }); }
  if (url.includes("/api/actions/restore/dry-run/")) {
    return json({ artifact: { id: "dr-7f3c", status: "completed", closureKeys: lastClosure, guardRefusals: [], results: {
      applied: lastClosure.map((naturalKey) => ({ naturalKey, reason: naturalKey.startsWith("group") ? "exists in target, unchanged" : "would update 3 properties" })),
      skipped: [], failed: [], notRemediable: [] },
      recoveryMechanisms: lastClosure.map((naturalKey) => naturalKey.startsWith("group:")
        ? { naturalKey, mechanism: "soft-delete-restore", idOutcome: "retained", retainedId: "g-1", deadline: "2026-10-30T09:00:00Z", credentialMode: "restorer", reason: null }
        : { naturalKey, mechanism: "update-existing", idOutcome: "retained", retainedId: "p-1", deadline: null, credentialMode: "restorer", reason: null }),
      relationshipOperations: lastClosure.filter((naturalKey) => naturalKey.startsWith("group:")).flatMap((parentNaturalKey) => [
        { parentNaturalKey, family: "member", action: "add", targetNaturalKey: "user:amara.okafor@contoso.example", targetId: "u-1" },
        { parentNaturalKey, family: "member", action: "remove", targetNaturalKey: "user:former.contractor@contoso.example", targetId: "u-2" },
      ]) } });
  }
  if (url.endsWith("/api/actions/restore")) return json({ approvalRequest: { id: "req-221" } }, 202);
  if (url.endsWith("/api/actions/remediate/selection")) {
    const { driftIds } = JSON.parse(String(init?.body)) as { driftIds: string[] };
    const picked = DRIFT.filter((item) => driftIds.includes(item.id));
    return json({ driftIds, resources: picked.map((item) => ({ naturalKey: item.naturalKey, resourceType: item.resourceType, verb: item.changeType === "added" ? "delete" : item.changeType === "removed" ? "create" : "update", verbReason: item.changeType === "modified" ? "live state differs from baseline" : "restores baseline presence" })),
      waves: [picked.filter((item) => item.resourceType !== "conditionalAccessPolicy").map((item) => item.naturalKey), picked.filter((item) => item.resourceType === "conditionalAccessPolicy").map((item) => item.naturalKey)].filter((wave) => wave.length),
      deletionWaves: [], patches: [], guardRefusals: [] });
  }
  if (url.endsWith("/api/actions/remediate")) return json({ approvalRequest: { id: "req-222" } }, 202);
  if (url.endsWith("/api/actions/dispose")) return json({ disposition: { id: "d" } });
  return json({ job: { id: "preview-job" }, approvalRequest: { id: "preview" } });
}) as typeof fetch;

const now = "2026-10-02T09:40:00Z";
const DRIFT = [
  { id: "dr1", naturalKey: "conditionalAccessPolicy:Block legacy auth", resourceType: "conditionalAccessPolicy", changeType: "modified", blastRadius: "tenant-lockout", detectedAt: "2026-10-02T09:12:00Z",
    before: { displayName: "Block legacy auth", state: "enabled", conditions: { clientAppTypes: ["exchangeActiveSync", "other"], users: { includeUsers: ["All"], excludeGroups: ["Break-glass admins"] } }, grantControls: { operator: "OR", builtInControls: ["block"] } },
    after: { displayName: "Block legacy auth", state: "enabledForReportingButNotEnforced", conditions: { clientAppTypes: ["exchangeActiveSync", "other"], users: { includeUsers: ["All"], excludeGroups: ["Break-glass admins", "Finance"] } }, grantControls: { operator: "OR", builtInControls: ["block"] } } },
  { id: "dr2", naturalKey: "conditionalAccessPolicy:Require MFA for admins", resourceType: "conditionalAccessPolicy", changeType: "modified", blastRadius: "tenant-lockout", detectedAt: "2026-10-01T21:40:00Z",
    before: { state: "enabled", grantControls: { builtInControls: ["mfa"] }, sessionControls: { signInFrequency: { value: 4, type: "hours" } } },
    after: { state: "enabled", grantControls: { builtInControls: ["mfa"] }, sessionControls: { signInFrequency: { value: 24, type: "hours" } } } },
  { id: "dr3", naturalKey: "group:Finance", resourceType: "group", changeType: "modified", blastRadius: "access-affecting", detectedAt: "2026-10-01T15:02:00Z",
    before: { displayName: "Finance", membershipRule: null, owners: ["cfo@contoso.com"] }, after: { displayName: "Finance", membershipRule: null, owners: ["cfo@contoso.com", "temp.contractor@contoso.com"] } },
  { id: "dr4", naturalKey: "namedLocation:Branch offices", resourceType: "namedLocation", changeType: "added", blastRadius: "access-affecting", detectedAt: "2026-09-30T10:00:00Z", before: null, after: { displayName: "Branch offices", ipRanges: ["203.0.113.0/24"] } },
  { id: "dr5", naturalKey: "deviceConfiguration:Windows baseline", resourceType: "deviceConfiguration", changeType: "modified", blastRadius: "cosmetic", detectedAt: "2026-09-29T08:30:00Z",
    before: { description: "Corporate Windows baseline", passwordMinimumLength: 12 }, after: { description: "Corporate Windows baseline v2", passwordMinimumLength: 12 } },
  { id: "dr6", naturalKey: "group:Old project team", resourceType: "group", changeType: "removed", blastRadius: "cosmetic", detectedAt: "2026-09-28T12:00:00Z", before: { displayName: "Old project team" }, after: null },
] as unknown as DriftRecord[];
type Job = Parameters<typeof JobTable>[0]["jobs"][number];
const job = (id: string, kind: string, status: string, extra: Partial<Job> = {}): Job => ({
  id, kind, status, params: { tier: "tier1" }, result: null, error: null, requestedBy: "marouanedefili@gmail.com",
  workerId: "worker-1", startedAt: "2026-10-02T09:31:00Z", heartbeatAt: "2026-10-02T09:39:40Z",
  createdAt: "2026-10-02T09:30:00Z", finishedAt: status === "running" || status === "queued" ? null : "2026-10-02T09:34:00Z", ...extra,
} as Job);
const initialJobs = [
  job("a1", "backup", "running"),
  job("a2", "collect", "queued"),
  job("a3", "restore-dry-run", "succeeded"),
  job("a4", "backup", "failed", { error: "Graph 429: throttled after 5 retries on /deviceManagement/deviceConfigurations" }),
  job("a5", "baseline-create", "succeeded", { requestedBy: "scheduler" }),
];

const header = (eyebrow: string, title: string, description: string, marker?: string) =>
  <PageHeader description={description} eyebrow={eyebrow} generatedAt={now} marker={marker} title={title} />;

const trend = [3, 1, 0, 0, 2, 5, 4, 1, 0, 0, 0, 6, 9, 3, 2, 1, 0, 0, 4, 2, 2, 1, 0, 0, 7, 12, 5, 3, 2, 4];
const ALERTS: DashboardData["alerts"][] = [
  [
    { severity: "critical", title: "Conditional Access drift with tenant-lockout blast radius", detail: "2 open changes to Conditional Access policies could block sign-in for administrators. Review before the next collection." },
    { severity: "warning", title: "3 catalog types are stale", detail: "Run a collection for the stale types; they were collected successfully but are no longer recent enough for their tier." },
  ],
  [{ severity: "warning", title: "3 catalog types are stale", detail: "Run a collection for the stale types; they were collected successfully but are no longer recent enough for their tier." }],
  [],
];
function dashboard(posture: number): DashboardData {
  return {
    generatedAt: now,
    activeBaseline: { id: "b-118", label: "Post-migration golden state", setAt: "2026-09-29T14:02:00Z", setBy: "marouanedefili@gmail.com", resourceCount: 4812 } as never,
    lastCollection: { completedAt: "2026-10-02T09:12:00Z", status: "complete" },
    lastCompletedCollectionAt: "2026-10-02T09:12:00Z",
    openDriftByBlastRadius: [{ blastRadius: "tenant-lockout", count: posture === 0 ? 2 : 0 }, { blastRadius: "access-affecting", count: 11 }, { blastRadius: "cosmetic", count: 24 }],
    openDriftTotal: posture === 0 ? 37 : 35,
    driftTrend: trend.map((count, index) => ({ day: new Date(Date.UTC(2026, 8, 3 + index)).toISOString().slice(0, 10), count })),
    coverage: { covered: 142, failed: posture === 0 ? 4 : 0, notCovered: 17, neverCollected: 4, stale: 3, total: 167 },
    evidence: { ok: true, chainLength: 18204 },
    alerts: ALERTS[posture],
  };
}

function Page({ path, jobs, posture }: { path: string; jobs: Job[]; posture: number }) {
  const active = jobs.some((item) => item.status === "running" || item.status === "queued");
  switch (path) {
    case "/": return <DashboardView data={dashboard(posture)} pendingApprovals={2} />;
    case "/jobs": return <>{header("Operations", "Jobs", "Job history and outcomes, newest first.")}<JobTable headingId="jobs-heading" jobs={jobs} kicker="Queue" title="Recent jobs" /><JobRefresher active={active} /></>;
    case "/backups": return <>{header("Recovery", "Backups", "Tiered backups on demand and their recent jobs.")}<BackupControls disabled={false} /><JobTable headingId="backup-jobs" jobs={jobs.filter((item) => item.kind === "backup")} kicker="History" title="Backup jobs" /></>;
    case "/restore": return <>{header("Recovery", "Restore", "Dependency-closed restore from a snapshot. Selecting a resource also selects everything it references, and a restore only runs after approval.", "Actionable")}
      <RestoreSelection canRestore resources={[
        ...Object.keys(DEPENDS),
        "group:Break-glass admins", "group:All managed devices", "namedLocation:HQ egress", "authenticationStrength:Phishing-resistant", "group:Finance", "namedLocation:Branch offices",
      ].map((naturalKey) => ({ naturalKey, resourceType: naturalKey.split(":")[0], blastRadius: naturalKey.startsWith("conditional") ? "tenant-lockout" : naturalKey.startsWith("group") ? "access-affecting" : "cosmetic" })) as never}
        snapshotId="snap-1" snapshots={[{ id: "snap-1", startedAt: "2026-10-02T09:01:00Z", completedAt: "2026-10-02T09:12:00Z", resourceCount: 4812 } as never]} />
      <JobTable headingId="restore-jobs-heading" jobs={jobs.filter((item) => item.kind.startsWith("restore"))} kicker="Queue" title="Restore jobs" /></>;
    case "/drift": return <>{header("Governance", "Drift", "Unresolved changes measured against the active recovery baseline.", "Actionable")}
      <section aria-label="Active baseline context" className="context-strip">
        <span className="active-indicator">Active baseline</span><strong>Post-migration golden state</strong><span>4,812 resources</span><span>2d old</span>
      </section>
      <DriftTable capabilities={["read", "dispose-accept", "remediate"]} items={DRIFT} /></>;
    case "/coverage": {
      const ct = (type: string, protectionState: string, extra: Record<string, unknown> = {}) => ({ type, reportStatus: protectionState === "failed" ? "failed" : protectionState === "not-covered" ? "not-covered" : "covered", protectionState, stale: false, itemCount: 42, lastCollectedAt: "2026-10-02T09:12:00Z", adapter: "graph.v1." + type, outcome: "complete", detail: null, fidelity: { declared: "full", measured: null, verifiedAt: null }, criticality: "tier1", blastRadius: "access-affecting", remappable: true, relationshipCompleteness: "unknown", ...extra });
      const types = [
        ct("conditionalAccessPolicy", "protected", { qualification: { decision: "automated", reason: "create/update/delete are registered; writes are forced report-only", softRestoreCandidate: false, remapping: { create: true, update: true } }, blastRadius: "tenant-lockout", itemCount: 14, fidelity: { declared: "full", measured: "full", verifiedAt: "2026-09-20T10:00:00Z" } }),
        ct("namedLocation", "protected", { itemCount: 6 }),
        ct("group", "partially-protected", { itemCount: 312, fidelity: { declared: "partial", measured: null, verifiedAt: null } }),
        ct("deviceConfiguration", "protected", { criticality: "tier2", blastRadius: "cosmetic", itemCount: 58 }),
        ct("servicePrincipal", "read-only", { criticality: "tier2", itemCount: 140 }),
        ct("directoryRoleTemplate", "unprotectable", { qualification: { decision: "manual", reason: "Microsoft-published template catalogue", softRestoreCandidate: false, remapping: {} }, criticality: "tier3", remappable: false, itemCount: 98 }),
        ct("authenticationMethodsPolicy", "failed", { itemCount: 0, outcome: "failed" }),
        ct("managedDevice", "not-covered", { adapter: null, itemCount: null, lastCollectedAt: null, fidelity: { declared: null, measured: null, verifiedAt: null }, criticality: "tier3", blastRadius: null }),
      ];
      return <>{header("Protection inventory", "Coverage", "Every known configuration type, including failed collections and missing adapters.", "Read-only")}
        <CoverageReport data={{ generatedAt: now, snapshot: { id: "s", status: "complete", startedAt: now, completedAt: now }, summary: { covered: 5, failed: 1, notCovered: 1, neverCollected: 0, stale: 0, total: 8 }, types } as never} /></>;
    }
    case "/jobs/a4": return <>{header("Operations", "Job details", "a4")}<a className="text-link back-link" href="#/jobs"><span aria-hidden="true">←</span> All jobs</a><JobDetail job={jobs.find((item) => item.id === "a4")!} /></>;
    case "/jobs/r9": return <>{header("Operations", "Job details", "r9")}<a className="text-link back-link" href="#/jobs"><span aria-hidden="true">←</span> All jobs</a><JobDetail job={{ ...jobs.find((item) => item.id === "a3")!, id: "r9", kind: "restore", params: { artifactId: "7f3c0000-0000-4000-8000-000000000009" }, result: { applied: 2, skipped: 0 } }} /><RecoveryCompletion canComplete restoreRef="7f3c0000-0000-4000-8000-000000000009" /></>;
    case "/jobs/a3": return <>{header("Operations", "Job details", "a3")}<a className="text-link back-link" href="#/jobs"><span aria-hidden="true">←</span> All jobs</a><JobDetail job={{ ...jobs.find((item) => item.id === "a3")!, result: { applied: 5, skipped: 0 } }} /></>;
    case "/approvals": return <>{header("Governance", "Approvals", "Review pending operator requests and retain a newest-first decision record.", "Approval required")}<ApprovalInbox
      history={[{ id: "r0", action: "drift.remediate", params: { driftIds: 3 }, requestedBy: "ops@contoso.com", justification: null, status: "approved", decidedBy: "marouanedefili@gmail.com", decidedAt: "2026-10-01T17:02:00Z", reason: null, createdAt: null, expiresAt: null }]}
      pending={[
        { id: "r1", action: "restore.enforce", params: { dryRunId: "dr-7f3c", resources: 12 }, requestedBy: "ops@contoso.com", justification: "Roll back CA policy edit from incident INC-2291", status: "pending", decidedBy: null, decidedAt: null, reason: null, createdAt: now, expiresAt: "2026-10-03T09:40:00Z" },
        { id: "r2", action: "baseline.activate", params: { baselineId: "b-118" }, requestedBy: "ops@contoso.com", justification: "Post-migration golden state", status: "pending", decidedBy: null, decidedAt: null, reason: null, createdAt: now, expiresAt: "2026-10-03T12:00:00Z" },
      ]} /></>;
    case "/notifications": return <>{header("Settings", "Notifications", "Notification delivery history and configuration.")}
      <DeliveryTable deliveries={[
        { id: "d1", event: { kind: "drift.detected", severity: "critical" }, channel_id: "ch-ops-webhook", channel_kind: "webhook", status: "retrying", attempts: 2, last_error: "transport timeout", next_attempt_at: "2026-10-02T09:45:00Z" },
        { id: "d2", event: { kind: "backup.completed", severity: "notice" }, channel_id: "ch-ops-mail", channel_kind: "email", status: "delivered", attempts: 1, last_error: null, next_attempt_at: null },
      ]} />
      <NotificationConsole canConfiguration
        channels={[{ id: "ch-ops-webhook", kind: "webhook", config: { url: "https://hooks.contoso.com/keel" }, enabled: true }, { id: "ch-ops-mail", kind: "email", config: { to: "secops@contoso.com", from: "keel@contoso.com" }, enabled: true }]}
        subscriptions={[{ id: "s1", channel_id: "ch-ops-webhook", event_glob: "drift.*", min_severity: "warning" }, { id: "s2", channel_id: "ch-ops-mail", event_glob: "*", min_severity: "critical" }]} /></>;
    case "/integrations": return <>{header("Settings", "Integrations", "SIEM and webhook destinations for the evidence stream.")}
      <IntegrationConsole canConfiguration
        destinations={[{ id: "dst1", tenant_ref: "t", name: "Sentinel CEF", kind: "cef", config: { transport: "https", url: "https://siem.contoso.com/cef" }, enabled: true, revoked_at: null, created_by: "x", created_at: now }]}
        statuses={[{ destinationId: "dst1", tenantRef: "t", kind: "cef", paused: false, pending: 14, delivering: 2, acknowledged: 18190, quarantined: 3, oldestPendingObservedAt: now, lagMs: 41000 } as never]} /></>;
    case "/evidence": return <>{header("Governance", "Evidence", "Decision history, newest first by sequence. Dates are UTC; range endpoints are inclusive.")}
      <ChainIndicator integrity={{ ok: true, status: "verified", anchoredThroughSeq: "18200", unanchoredRecords: 4 }} />
      <EvidenceTimeline query="" data={{ generatedAt: now, nextBefore: "18201", entries: [
        { seq: "18204", occurred_at: "2026-10-02T09:38:12Z", kind: "approval.decided", actor: "marouanedefili@gmail.com", subject: { request: "r0", decision: "approve" } },
        { seq: "18203", occurred_at: "2026-10-02T09:31:00Z", kind: "job.started", actor: "worker-1", subject: { job: "a1", kind: "backup" } },
        { seq: "18202", occurred_at: "2026-10-02T09:12:44Z", kind: "collection.completed", actor: "scheduler", subject: { types: 142, items: 4812 } },
      ] }} /></>;
    case "/principals": return <>{header("Governance", "Principals", "Identities, role grants, and effective capabilities.")}<div className="item-list">
      <PrincipalDetails principal={{ id: "p-01", email: "marouanedefili@gmail.com", disabled_at: null, capabilities: ["read", "users", "roles", "policies", "configuration"], role_grants: [{ id: "g-01", role: "admin", active_from: "2026-09-01T00:00:00Z", active_until: null }, { id: "g-02", role: "viewer", active_from: "2026-09-01T00:00:00Z", active_until: null }] } as never} />
      <PrincipalDetails principal={{ id: "p-02", email: "former.contractor@contoso.com", disabled_at: "2026-09-20T10:00:00Z", capabilities: [], role_grants: [] } as never} /></div></>;
    case "/policies/p1": return <>{header("Governance", "Auto-accept cosmetic drift", "Current policy configuration and automation state.")}
      <PolicyState policy={{ enabled: true, paused_at: null, run_as_repair_required: false, run_as_principal_id: "svc-policy", action: "dispose-accept", max_blast_radius: "cosmetic", max_actions_per_window: 50, window_seconds: 3600, resource_type: null, blast_radius: "cosmetic", natural_key_glob: "deviceConfiguration:*", change_type: "modified" } as never} />
      <section aria-label="Policy record" className="policy-group policy-meta"><h3>Record</h3><dl className="kv-grid"><dt>Policy ID</dt><dd>p1</dd><dt>Created by</dt><dd>marouanedefili@gmail.com</dd><dt>Created at</dt><dd>2026-09-12T08:00:00Z</dd></dl></section></>;
    case "/policies": return <>{header("Operations", "Policies", "Automation policies and their current state.")}<KillSwitchBadge disabled={false} />
      <section className="item-card" style={{ marginTop: "1rem" }}><h2><a className="item-title-link" href="#/policies/p1">Auto-accept cosmetic drift</a></h2>
        <PolicyState policy={{ enabled: true, paused_at: null, run_as_repair_required: false, run_as_principal_id: "svc-policy", action: "dispose-accept", max_blast_radius: "cosmetic", max_actions_per_window: 50, window_seconds: 3600, resource_type: null, blast_radius: "cosmetic", natural_key_glob: null, change_type: "modified" } as never} /></section></>;
    default: return <section className="empty-state state-page"><p className="eyebrow">Preview</p><h2>Not included in this preview</h2><p>This page needs live tenant data. Its styling and motion are the same as the pages shown here.</p></section>;
  }
}

function App() {
  const path = usePathname();
  const [jobs, setJobs] = useState(initialJobs);
  const [loading, setLoading] = useState(false);
  const [posture, setPosture] = useState(0);

  useEffect(() => { window.scrollTo(0, 0); }, [path]);

  function finishJob() {
    location.hash = "/jobs";
    setTimeout(() => setJobs((list) => {
      const running = list.findIndex((item) => item.status === "running");
      const queued = list.findIndex((item) => item.status === "queued");
      return list.map((item, index) => index === running ? { ...item, status: "succeeded", finishedAt: now }
        : index === queued ? { ...item, status: "running" } : item);
    }), 400);
  }

  return <>
    <div className="preview-bar">
      <span>Sample data</span>
      <button className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1400); }} type="button">Show loading state</button>
      <button className="btn btn-secondary btn-sm" onClick={() => { location.hash = "/"; setPosture((value) => (value + 1) % 3); }} type="button">Cycle posture</button>
      <button className="btn btn-secondary btn-sm" onClick={finishJob} type="button">Advance jobs</button>
    </div>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <div className="app-shell">
      <aside className="sidebar">
        <a aria-label="KEEL dashboard" className="brand" href="#/"><span aria-hidden="true" className="brand-mark"><KeelMark /></span><span><strong>KEEL</strong><small>Operator portal</small></span></a>
        <CommandPalette canApprove canPolicies canRead canUsers />
        <NavLinks canApprove canPolicies canRead canUsers pendingApprovals={2} />
        <div className="operator-context">
          <span className="auth-state"><span aria-hidden="true" className="auth-dot" /> Authenticated</span>
          <span className="operator-email">marouanedefili@gmail.com</span>
          <span className="access-label">Read + 10 action capabilities</span>
          <ThemeToggle initial="system" />
        </div>
      </aside>
      <main className="workspace" id="main-content">
        <div className="page-transition" key={loading ? "loading" : `${path}:${posture}`}>
          {loading ? <PageSkeleton /> : <Page jobs={jobs} path={path} posture={posture} />}
        </div>
      </main>
    </div>
    <Toaster />
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
