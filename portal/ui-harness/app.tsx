import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { CommandPalette } from "@/components/command-palette";
import { NavLinks, SectionTabs, type NavSection } from "@/components/nav-links";
import { KeelMark } from "@/components/keel-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Toaster } from "@/components/toaster";
import { PageHeader } from "@/components/page-header";
import { JobTable } from "@/components/job-table";
import { JobRefresher } from "@/components/job-refresher";
import { PageSkeleton } from "@/components/ui/skeleton";
import { BackupControls, ProblemList } from "@/components/backup-controls";
import { ScheduleTable, schedulesVerdict } from "@/components/schedule-table";
import { protectProblems, protectVerdict, tierSummaries } from "@/lib/protect-view";
import type { Schedule, ScheduleForecast } from "@/lib/schedules";
import { ApprovalInbox } from "@/components/approval-inbox";
import { DeliveryTable, NotificationConsole } from "@/components/notification-console";
import { IntegrationConsole } from "@/components/integration-console";
import { ActivityTimeline, IntegrityNote, activityVerdict, mergeActivity } from "@/components/activity-timeline";
import { BaselineRegister } from "@/components/baseline-register";
import { Verdict } from "@/components/verdict";
import { PrincipalDetails } from "@/components/principal-details";
import { AutomationBanner, PolicyCard, policiesVerdict, policySentence } from "@/components/policy-state";
import { usePathname } from "next/navigation";
import { RestoreSelection } from "@/components/restore-selection";
import { DriftTable } from "@/components/drift-table";
import { BaselineContext } from "@/components/baseline-context";
import { changesVerdict } from "@/lib/changes-view";
import { CoverageReport } from "@/components/coverage-report";
import { JobDetail, jobVerdict } from "@/components/job-detail";
import { RecoveryCompletion } from "@/components/recovery-completion";
import { CompensationPanel } from "@/components/compensation-panel";
import { IncidentRecovery } from "@/components/incident-recovery";
import type { IncidentDetail } from "@/lib/portal-data";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import type { BaselineCapture, BaselineChanges, BaselineRecord, ComplianceData, CoverageData, CoverageType, DashboardData, DriftRecord } from "@/lib/types";
import { ComplianceReport } from "@/components/compliance-report";
import { baselinesVerdict, complianceVerdict } from "@/lib/compliance-view";
import { accessSummary } from "@/lib/presentation";
import { EMPTY_REFERENCES, type RowReferences } from "@/lib/sentences";
import { notificationsVerdict } from "@/lib/notifications-view";
import { integrationsVerdict } from "@/lib/integrations-view";
import type { Policy } from "@/lib/policies";
import { SetupProgress } from "@/components/setup-progress";
import { setupVerdict, type SetupState } from "@/lib/setup-view";
import { AlertInbox } from "@/components/alert-inbox";
import { alertsVerdict, type AlertItem } from "@/lib/alerts-view";

// UI harness: the real portal components with fixture data (see build.mjs).
// Each API the restore wizard calls gets a plausible answer after
// a short delay so the real component walks its real states.
const DEPENDS: Record<string, string[]> = {
  "conditionalAccessPolicy:Block legacy auth": ["group:Break-glass admins", "namedLocation:HQ egress"],
  "conditionalAccessPolicy:Require MFA for admins": ["group:Break-glass admins", "authenticationStrength:Phishing-resistant"],
  "deviceConfiguration:Windows baseline": ["group:All managed devices"],
};
let jobPolls = 0;
let contentEffectsApproved = false;
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
  // Task-70: the undo plan of failed restore r10.
  if (url.endsWith("/api/actions/restore/compensate")) return json({ job: { id: "job-undo-r10" }, artifactId: "c0de0000-0000-4000-8000-000000000010" }, 202);
  if (url.includes("/api/actions/restore/dry-run/c0de0000")) return json({ artifact: COMPENSATION_ARTIFACT });
  if (url.endsWith("/api/actions/restore/dry-run")) { jobPolls = 0; return json({ job: { id: "job-dry-7f3c" }, artifactId: "dr-7f3c" }, 202); }
  if (url.includes("/api/jobs/")) { jobPolls += 1; return json({ job: { status: jobPolls >= 2 ? "succeeded" : "running" } }); }
  if (url.includes("/api/actions/restore/dry-run/")) {
    return json({ artifact: { id: "dr-7f3c", status: "completed", closureKeys: lastClosure, guardRefusals: [], results: {
      applied: lastClosure.map((naturalKey) => ({ naturalKey, reason: naturalKey.startsWith("group") ? "exists in target, unchanged" : "would update 3 properties" })),
      skipped: [], failed: [], notRemediable: [] },
      effectsDigest: "digest-1",
      contentEffectApprovals: contentEffectsApproved ? [{ approvedBy: "approver@contoso.example", approvedAt: "2026-10-03T08:00:00Z" }] : [],
      contentEffects: lastClosure.includes("group:Break-glass admins") ? [{
        naturalKey: "group:Break-glass admins", resourceType: "group", field: "visibility", effect: "externally-sharing", before: "Private", after: "Public",
        disclosure: "Content becomes visible to people outside its current audience. KEEL backs up configuration, not content: content deleted or disclosed while this setting is in effect is not recoverable by KEEL, and restoring the previous setting later does not bring it back.",
      }] : [],
      recoveryMechanisms: lastClosure.map((naturalKey) => naturalKey.startsWith("group:")
        ? { naturalKey, mechanism: "soft-delete-restore", idOutcome: "retained", retainedId: "g-1", deadline: "2026-10-30T09:00:00Z", credentialMode: "restorer", reason: null }
        : { naturalKey, mechanism: "update-existing", idOutcome: "retained", retainedId: "p-1", deadline: null, credentialMode: "restorer", reason: null }),
      relationshipOperations: lastClosure.filter((naturalKey) => naturalKey.startsWith("group:")).flatMap((parentNaturalKey) => [
        { parentNaturalKey, family: "member", action: "add", targetNaturalKey: "user:amara.okafor@contoso.example", targetId: "u-1" },
        { parentNaturalKey, family: "member", action: "remove", targetNaturalKey: "user:former.contractor@contoso.example", targetId: "u-2" },
      ]) } });
  }
  if (url.endsWith("/api/actions/restore/content-effects")) { contentEffectsApproved = true; return json({ approval: { id: "cea-1" } }); }
  if (url.endsWith("/api/actions/restore")) return json({ approvalRequest: { id: "req-221" } }, 202);
  if (url.endsWith("/api/actions/remediate/selection")) {
    const { driftIds } = JSON.parse(String(init?.body)) as { driftIds: string[] };
    const picked = DRIFT.filter((item) => driftIds.includes(item.id));
    return json({ driftIds, resources: picked.map((item) => ({ naturalKey: item.naturalKey, resourceType: item.resourceType, verb: item.changeType === "added" ? "delete" : item.changeType === "removed" ? "create" : "update", verbReason: item.changeType === "modified" ? "live state differs from baseline" : "restores baseline presence" })),
      waves: [picked.filter((item) => item.resourceType !== "conditionalAccessPolicy").map((item) => item.naturalKey), picked.filter((item) => item.resourceType === "conditionalAccessPolicy").map((item) => item.naturalKey)].filter((wave) => wave.length),
      deletionWaves: [], patches: [],
      // Task-131: a synced group is refused, with the guard's own coded reason.
      guardRefusals: picked.filter((item) => item.naturalKey === "group:Finance").map((item) => ({ naturalKey: item.naturalKey, reason: "onPremisesSyncEnabled=true — source of authority is on-premises Active Directory, cloud-side restore is refused" })) });
  }
  if (url.endsWith("/api/actions/remediate")) return json({ approvalRequest: { id: "req-222" } }, 202);
  if (url.endsWith("/api/actions/dispose")) return json({ disposition: { id: "d" } });
  if (url.endsWith("/api/actions/alerts")) return json({ alert: { id: INBOX_ALERTS[0].id, state: "acknowledged" } });
  if (url.endsWith("/api/actions/setup")) return json({ run: { artifactId: SETUP_RUN, status: "pending-manual", stepId: null } });
  return json({ job: { id: "preview-job" }, approvalRequest: { id: "preview" } });
}) as typeof fetch;

const COMPENSATION_ARTIFACT = {
  id: "c0de0000-0000-4000-8000-000000000010",
  status: "completed",
  guardRefusals: [],
  contentEffects: [],
  compensation: {
    compensates: "7f3c0000-0000-4000-8000-000000000010",
    atomic: false,
    statement: "Compensation is not atomic: each inverse write is a separate, verified Graph call, and only writes this restore actually made are undone. It never restores erased or disclosed content.",
    operations: [
      { naturalKey: "group:Finance", resourceType: "group", verb: "update", undoes: "update", revertedFields: ["description", "visibility"] },
      { naturalKey: "group:Project Falcon", resourceType: "group", verb: "delete", undoes: "create" },
    ],
    conflicts: [{ naturalKey: "conditionalAccessPolicy:Require MFA for admins", reason: "concurrent-change: sessionControls changed after this restore wrote it — compensation will not overwrite a later change" }],
    irrecoverable: [
      { naturalKey: "group:Finance", effect: "externally-sharing", field: "visibility", reason: "Content becomes visible to people outside its current audience. KEEL backs up configuration, not content: content deleted or disclosed while this setting is in effect is not recoverable by KEEL, and restoring the previous setting later does not bring it back." },
      { naturalKey: "group:Contractors", effect: "object-deleted", field: "(object deleted)", reason: "This restore deleted group:Contractors. Compensation does not recreate it: a recreated object gets a new id. Recover it with a forward restore — a native soft-delete restore keeps the id while the object is still in deleted items." },
    ],
    manual: [{ naturalKey: "group:Finance|member|user:amara.okafor@contoso.example", reason: "relationship edge: membership compensation is not a qualified operation — review this edge by hand" }],
    notApplied: [{ naturalKey: "namedLocation:HQ egress", reason: "Graph rejected this write (status 400); nothing to undo" }],
  },
};

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
// Task-130: references arrive resolved, as the engine readers return them.
const personRef = (id: string, name: string) => ({ kind: "person", id, name, readable: true, email: name.includes("@") ? name : null, system: !name.includes("@") });
const refs = (requester: string, extra: Partial<RowReferences> = {}): RowReferences => ({
  ...EMPTY_REFERENCES, people: { requested_by: personRef(requester.includes("@") ? "8c1e0000-0000-4000-8000-0000000000a1" : requester, requester) }, ...extra,
});
const job = (id: string, kind: string, status: string, extra: Partial<Job> = {}): Job => ({
  id, kind, status, params: { tier: "tier1" }, result: null, error: null, requestedBy: "marouanedefili@gmail.com",
  references: refs((extra.requestedBy as string | undefined) ?? "marouanedefili@gmail.com"),
  workerId: "worker-1", startedAt: "2026-10-02T09:31:00Z", heartbeatAt: "2026-10-02T09:39:40Z",
  createdAt: "2026-10-02T09:30:00Z", finishedAt: status === "running" || status === "queued" ? null : "2026-10-02T09:34:00Z", ...extra,
} as Job);
const initialJobs = [
  job("a1", "backup", "running"),
  job("a2", "collect", "queued"),
  job("a3", "restore", "succeeded", { params: { snapshotId: "5a2be911-0000-4000-8000-000000000002", selection: ["group:Finance", "conditionalAccessPolicy:Block legacy auth"], artifactId: "7f3c0000-0000-4000-8000-000000000009" }, references: refs("marouanedefili@gmail.com", { snapshot: { kind: "snapshot", id: "5a2be911-0000-4000-8000-000000000002", name: null, readable: true, takenAt: "2026-10-02T09:12:00Z" } }) }),
  job("a4", "backup", "failed", { error: "Graph 429: throttled after 5 retries on /deviceManagement/deviceConfigurations" }),
  job("a5", "baseline-create", "succeeded", { requestedBy: "scheduler", params: { label: "Post-migration golden state" } }),
];

const POLICY: Policy = {
  id: "7a1d0f3e-0000-4000-8000-000000000001", name: "Auto-accept cosmetic drift", enabled: true, paused_at: null, run_as_repair_required: false,
  run_as_principal_id: "3f9c2b1e-0000-4000-8000-000000000002",
  run_as_principal: { id: "3f9c2b1e-0000-4000-8000-000000000002", email: "svc-policy@contoso.com", name: "svc-policy@contoso.com", readable: true },
  resource_type: null, blast_radius: "cosmetic", natural_key_glob: null, change_type: "modified", action: "auto_remediate",
  max_blast_radius: "cosmetic", max_actions_per_window: 50, window_seconds: 3600, created_by: "marouanedefili@gmail.com", created_at: "2026-09-12T08:00:00Z",
  last_action_at: "2026-10-02T07:40:00Z", last_action_status: "executed", last_action_natural_key: "namedLocation:Branch offices", actions_last_7_days: 14,
};
const POLICIES: Policy[] = [POLICY, {
  ...POLICY, id: "7a1d0f3e-0000-4000-8000-000000000003", name: "Alert on lockout risk", action: "alert", blast_radius: "tenant-lockout", change_type: null,
  max_blast_radius: "tenant-lockout", max_actions_per_window: null, window_seconds: null, run_as_principal_id: null, run_as_principal: null,
  last_action_at: null, last_action_status: null, last_action_natural_key: null, actions_last_7_days: 0,
}];
const CHANNELS = [{ id: "c4e10000-0000-4000-8000-0000000000c1", kind: "webhook", config: { url: "https://hooks.contoso.com/keel" }, enabled: true }, { id: "c4e10000-0000-4000-8000-0000000000c2", kind: "email", config: { to: "secops@contoso.com", from: "keel@contoso.com" }, enabled: true }, { id: "c4e10000-0000-4000-8000-0000000000c3", kind: "pagerduty", config: { routingKeyRef: "env:KEEL_PAGERDUTY_KEY", region: "eu" }, enabled: true }, { id: "c4e10000-0000-4000-8000-0000000000c4", kind: "slack", config: { endpointRef: "env:KEEL_SLACK_WEBHOOK" }, enabled: true }];
const DELIVERIES = [
  { id: "d0e10000-0000-4000-8000-0000000000d1", event: { kind: "drift.detected", severity: "critical" }, channel_id: CHANNELS[0].id, channel_kind: "webhook", status: "retrying", attempts: 2, last_error: "the webhook did not answer in time", next_attempt_at: "2026-10-02T09:45:00Z" },
  { id: "d0e10000-0000-4000-8000-0000000000d2", event: { kind: "drift.detected", severity: "notice" }, channel_id: CHANNELS[1].id, channel_kind: "email", status: "delivered", attempts: 1, last_error: null, next_attempt_at: null },
  { id: "d0e10000-0000-4000-8000-0000000000d3", event: { kind: "drift.detected", severity: "critical" }, channel_id: CHANNELS[2].id, channel_kind: "pagerduty", status: "delivered", attempts: 2, last_error: null, next_attempt_at: null, provider_receipt: { channel: "pagerduty", provider: "pagerduty", outcome: "delivered", httpStatus: 202, semantics: "Accepted by PagerDuty. Events with the same dedup key join one incident.", endpointHost: "events.eu.pagerduty.com", dedupKey: "keel:alert:6f1c2a54-1d3b-4c8e-9a51-3e0d7c1b2a90:1" } },
  { id: "d0e10000-0000-4000-8000-0000000000d4", event: { kind: "drift.detected", severity: "warning" }, channel_id: CHANNELS[3].id, channel_kind: "slack", status: "failed", attempts: 1, last_error: "Slack refused the message (HTTP 404): the webhook was removed or turned off", next_attempt_at: null, provider_receipt: { channel: "slack", provider: "slack", outcome: "rejected", httpStatus: 404, endpointHost: "hooks.slack.com", providerStatus: "no_service" } },
];
const DESTINATIONS = [{ id: "de570000-0000-4000-8000-0000000000e1", tenant_ref: "t", name: "Sentinel CEF", kind: "cef", config: { transport: "https", url: "https://siem.contoso.com/cef", acknowledgement: "http-response" }, enabled: true, revoked_at: null, created_by: "marouanedefili@gmail.com", created_at: now }];
const DESTINATION_STATUSES = [{ destinationId: DESTINATIONS[0].id, tenantRef: "t", kind: "cef", paused: false, pending: 14, delivering: 2, acknowledged: 18190, quarantined: 3, oldestPendingObservedAt: now, lagMs: 41000 }] as never[];
const EVIDENCE = [
  { seq: "18204", occurred_at: "2026-10-02T09:38:12Z", kind: "approval-decision", actor: "marouanedefili@gmail.com", subject: { requestId: "r0", decision: "approve" } },
  { seq: "18203", occurred_at: "2026-10-02T09:31:00Z", kind: "action-attempt", actor: "marouanedefili@gmail.com", subject: { action: "backup", decision: "attempted" } },
  { seq: "18202", occurred_at: "2026-10-02T09:12:44Z", kind: "collection.completed", actor: "scheduler", subject: { types: 142, items: 4812 } },
];
const CAPTURED = (capturedAt: string, sourceSnapshotId: string | null, basis: BaselineCapture["basis"] = "source-snapshot"): BaselineCapture => ({
  basis, capturedAt, ageMs: Date.parse(now) - Date.parse(capturedAt), sourceSnapshotId,
  window: { startedAt: capturedAt.replace(/:\d\dZ$/, ":00Z"), completedAt: capturedAt },
  types: ["conditionalAccessPolicy", "group", "namedLocation", "roleAssignment", "user", "application"],
});
const COMPARED = (added: number, modified: number, removed: number): BaselineChanges => ({
  state: "compared", comparedSnapshotId: "0b5e0000-0000-4000-8000-0000000000d6", comparedAt: "2026-10-02T09:12:00Z",
  added, modified, removed, total: added + modified + removed,
});
const BASELINES: BaselineRecord[] = [
  { id: "b1180000-0000-4000-8000-000000000118", label: "Post-migration golden state", description: "After the tenant move", setAt: "2026-09-29T14:02:00Z", setBy: "8c1e0000-0000-4000-8000-0000000000a1", setByRef: { kind: "person", id: "8c1e0000-0000-4000-8000-0000000000a1", name: "marouanedefili@gmail.com", href: "/principals" }, active: true, resourceCount: 4812,
    version: 1, supersedesId: null, supersededById: null, supersededAt: null, capture: CAPTURED("2026-09-29T13:40:00Z", "0b5e0000-0000-4000-8000-0000000000c8"), changesSinceCapture: COMPARED(1, 2, 0) },
  { id: "b1170000-0000-4000-8000-000000000117", label: "Before migration (v2)", description: null, setAt: "2026-09-01T09:00:00Z", setBy: "scheduler", setByRef: { kind: "person", id: "scheduler", name: "scheduler", href: null }, active: false, resourceCount: 4590,
    version: 2, supersedesId: "b1160000-0000-4000-8000-000000000116", supersededById: null, supersededAt: null, capture: CAPTURED("2026-09-01T08:30:00Z", "0b5e0000-0000-4000-8000-0000000000a9"), changesSinceCapture: COMPARED(30, 9, 2) },
  { id: "b1160000-0000-4000-8000-000000000116", label: "Before migration", description: null, setAt: "2026-08-20T10:00:00Z", setBy: "scheduler", setByRef: { kind: "person", id: "scheduler", name: "scheduler", href: null }, active: false, resourceCount: 4502,
    version: 1, supersedesId: null, supersededById: "b1170000-0000-4000-8000-000000000117", supersededAt: "2026-09-01T09:00:00Z", capture: CAPTURED("2026-08-20T09:30:00Z", null, "legacy-resource-versions"), changesSinceCapture: COMPARED(44, 12, 3) },
];
const CAPTURE_SOURCES = [{ id: "0b5e0000-0000-4000-8000-0000000000d6", completedAt: "2026-10-02T09:12:00Z" }];

// Roadmap task-87: every finding state the compliance view distinguishes.
const evidenceWindow = (resourceType: string, startedAt: string, endedAt: string, snapshotId: string | null) => ({
  resourceType, window: { startedAt, endedAt }, snapshotId, completedAt: snapshotId ? endedAt : null,
});
const ROLE_EVIDENCE = evidenceWindow("roleAssignment", "2026-10-02T09:00:00Z", "2026-10-02T09:12:00Z", "0b5e0000-0000-4000-8000-0000000000d6");
const COMPLIANCE: ComplianceData = {
  generatedAt: now,
  activeBaseline: BASELINES[0],
  summary: { controls: 4, exposed: 1, excepted: 1, expiredExceptions: 1, incompleteExceptions: 0, passing: 1, unknown: 1, notApplicable: 0 },
  storage: { configured: true, provider: "local-disk", region: "westeurope", boundary: "keel-vps-backup-volume", immutability: "unsupported", generatedAt: "2026-10-02T05:00:00Z", certifies: null, source: "/opt/backups/keel-recovery-manifest.json" },
  findings: [
    { id: "e7a10000-0000-4000-8000-0000000000e1", controlId: "keel-custom.role-assignment.admin-count-at-most", title: "Global Administrator assignment count stays at or below a set limit",
      framework: "keel-custom", edition: "2026.1", profile: "baseline", evaluatorVersion: 1, verdict: "fail", reason: null, evaluatedAt: "2026-10-02T09:20:00Z", evidenceSeq: "4182",
      exceptionState: "expired", exposed: true,
      exception: { id: "e7c10000-0000-4000-8000-0000000000c1", owner: "secops@contoso.com", reason: "Two break-glass accounts during the migration", grantedBy: "8c1e0000-0000-4000-8000-0000000000a1", grantedAt: "2026-09-01T10:00:00Z", expiresAt: "2026-09-30T00:00:00Z" },
      evidence: [ROLE_EVIDENCE],
      links: {
        backup: { state: "linked", linked: [ROLE_EVIDENCE], mismatched: [] },
        change: { state: "linked",
          linked: [{ id: "d7100000-0000-4000-8000-0000000000d1", naturalKey: "roleAssignment:Global Administrator · adele@contoso.com", resourceType: "roleAssignment", changeType: "added", snapshotId: "0b5e0000-0000-4000-8000-0000000000d6", detectedAt: "2026-10-02T09:14:00Z" }],
          mismatched: [{ id: "d7100000-0000-4000-8000-0000000000d2", naturalKey: "roleAssignment:Global Administrator · grady@contoso.com", resourceType: "roleAssignment", changeType: "added", snapshotId: "0b5e0000-0000-4000-8000-0000000000c8", detectedAt: "2026-09-30T09:14:00Z" }] },
        restorePlan: { state: "linked", linked: [{ requestId: "a9e10000-0000-4000-8000-000000000100", dryRunId: "7f3c0000-0000-4000-8000-000000000011", snapshotId: "0b5e0000-0000-4000-8000-0000000000d6", createdAt: "2026-10-02T09:30:00Z", expiresAt: "2026-10-03T09:30:00Z" }], mismatched: [] },
      } },
    { id: "e7a10000-0000-4000-8000-0000000000e2", controlId: "keel-custom.named-location.no-untrusted-all-countries", title: "No named location marks unknown-country traffic as trusted",
      framework: "keel-custom", edition: "2026.1", profile: "baseline", evaluatorVersion: 1, verdict: "fail", reason: null, evaluatedAt: "2026-10-02T09:20:00Z", evidenceSeq: "4183",
      exceptionState: "authorized", exposed: false,
      exception: { id: "e7c10000-0000-4000-8000-0000000000c2", owner: "network@contoso.com", reason: "Branch offices route through a trusted proxy until the November cutover.", grantedBy: "8c1e0000-0000-4000-8000-0000000000a1", grantedAt: "2026-09-15T10:00:00Z", expiresAt: "2026-11-30T00:00:00Z" },
      evidence: [evidenceWindow("namedLocation", "2026-10-02T09:00:00Z", "2026-10-02T09:12:00Z", "0b5e0000-0000-4000-8000-0000000000d6")],
      links: {
        backup: { state: "linked", linked: [evidenceWindow("namedLocation", "2026-10-02T09:00:00Z", "2026-10-02T09:12:00Z", "0b5e0000-0000-4000-8000-0000000000d6")], mismatched: [] },
        change: { state: "none", linked: [], mismatched: [] },
        restorePlan: { state: "none", linked: [], mismatched: [] },
      } },
    { id: "e7a10000-0000-4000-8000-0000000000e3", controlId: "keel-custom.group.role-assignable-not-synced", title: "Role-assignable groups are not synchronized from on-premises AD",
      framework: "keel-custom", edition: "2026.1", profile: "baseline", evaluatorVersion: 1, verdict: "unknown", reason: "group:stale", evaluatedAt: "2026-10-01T09:20:00Z", evidenceSeq: "4101",
      exceptionState: "none", exposed: false, exception: null, evidence: [],
      links: { backup: { state: "none", linked: [], mismatched: [] }, change: { state: "none", linked: [], mismatched: [] }, restorePlan: { state: "none", linked: [], mismatched: [] } } },
    { id: "e7a10000-0000-4000-8000-0000000000e4", controlId: "keel-custom.conditional-access.block-legacy", title: "Legacy authentication is blocked",
      framework: "keel-custom", edition: "2026.1", profile: "baseline", evaluatorVersion: 1, verdict: "pass", reason: null, evaluatedAt: "2026-09-28T09:20:00Z", evidenceSeq: "3990",
      exceptionState: "none", exposed: false, exception: null,
      evidence: [evidenceWindow("conditionalAccessPolicy", "2026-09-28T09:00:00Z", "2026-09-28T09:11:00Z", null)],
      links: { backup: { state: "mismatch", linked: [], mismatched: [evidenceWindow("conditionalAccessPolicy", "2026-09-28T09:00:00Z", "2026-09-28T09:11:00Z", null)] }, change: { state: "none", linked: [], mismatched: [] }, restorePlan: { state: "none", linked: [], mismatched: [] } } },
  ],
};
const PLAN_REF = { kind: "dry-run", id: "7f3c0000-0000-4000-8000-000000000011", name: null, readable: true, status: "completed", undo: false, resources: 12, snapshotAt: "2026-10-02T09:12:00Z", dryRunJobId: "a3" };

// Task-131: every configuration-type state task-54 tested, mirrored into the Protect
// drawers. Each type carries the full evidence its record must keep.
const PROOF = { update: "engine/restore/updatePath.test.mjs", create: "engine/restore/createPath.test.mjs" };
const write = (claim: string, proof: string | null, credentialMode: string | null = "restorer") => ({ claim, credentialMode, idOutcome: null, handler: null, proofRef: proof, projection: "reviewed-empty" });
const ct = (type: string, protectionState: string, extra: Partial<CoverageType> = {}): CoverageType => ({
  type, reportStatus: protectionState === "failed" ? "failed" : protectionState === "not-covered" ? "not-covered" : "covered", protectionState, stale: false, itemCount: 42,
  lastCollectedAt: "2026-10-02T09:12:00Z", adapter: "graph-v1-" + type, outcome: "complete",
  detail: { httpStatus: 200, graphCode: null, message: null, endpoint: `/v1.0/${type}`, apiVersion: "v1.0", pagesCompleted: 3, startedAt: "2026-10-02T09:01:00Z", completedAt: "2026-10-02T09:12:00Z" },
  fidelity: { declared: "full", measured: null, verifiedAt: null }, criticality: "tier1", blastRadius: "access-affecting", remappable: true,
  declaredEndpoint: { path: `/${type}`, apiVersion: "v1.0" }, irrecoverableFields: [], relationshipCompleteness: "unknown", diagnosis: null,
  writeCapability: { resourceType: type, operations: { create: write("fixture-tested", PROOF.create), update: write("fixture-tested", PROOF.update), delete: write("declared", null), "restore-soft-deleted": write("unsupported", null, null) } },
  qualification: null,
  observation: { observationId: `0b5e0000-0000-4000-8000-${type.length.toString().padStart(12, "0")}`, window: { startedAt: "2026-10-02T09:01:00Z", endedAt: "2026-10-02T09:12:00Z" }, completeness: "complete", evidenceLevel: "fixture-tested" },
  ...extra,
} as CoverageType);
const COVERAGE_TYPES: CoverageType[] = [
  ct("conditionalAccessPolicy", "protected", { qualification: { decision: "automated", reason: "create/update/delete are registered; writes are forced report-only", softRestoreCandidate: false, remapping: { create: true, update: true }, expansion: { batch: "policy", batchLabel: "Policies", status: "qualified-subset", restoreScope: "partial", reason: "registered before task-107; forced report-only" } }, blastRadius: "tenant-lockout", itemCount: 14, fidelity: { declared: "full", measured: "full", verifiedAt: "2026-09-20T10:00:00Z" },
    writeCapability: { resourceType: "conditionalAccessPolicy", operations: { create: write("live-qualified", "docs/release/qualification/ca-create.json"), update: write("live-qualified", "docs/release/qualification/ca-update.json"), delete: write("fixture-tested", "engine/restore/deletePath.test.mjs"), "restore-soft-deleted": write("unsupported", null, null) } } as never }),
  ct("namedLocation", "protected", { itemCount: 0, outcome: "complete-empty" }),
  ct("group", "partially-protected", { itemCount: 312, fidelity: { declared: "partial", measured: "partial", verifiedAt: "2026-09-21T10:00:00Z" }, irrecoverableFields: ["createdDateTime", "securityIdentifier"], qualification: { decision: "automated", reason: null, softRestoreCandidate: true, remapping: { create: false } } }),
  ct("deviceConfiguration", "protected", { criticality: "tier2", blastRadius: "cosmetic", itemCount: 58, stale: true, lastCollectedAt: "2026-09-28T09:12:00Z",
    observation: { observationId: "0b5e0000-0000-4000-8000-0000000000d5", window: { startedAt: "2026-09-28T09:00:00Z", endedAt: "2026-09-28T09:12:00Z" }, completeness: "complete", evidenceLevel: "fixture-tested" } }),
  ct("servicePrincipal", "read-only", { criticality: "tier2", itemCount: 140, fidelity: { declared: "read-only", measured: null, verifiedAt: null } }),
  ct("directoryRoleTemplate", "unprotectable", { qualification: { decision: "manual", reason: "Microsoft-published template catalogue", softRestoreCandidate: false, remapping: {} }, criticality: "tier3", remappable: false, itemCount: 98, fidelity: { declared: "unprotectable", measured: null, verifiedAt: null } }),
  ct("authenticationMethodsPolicy", "failed", { itemCount: 0, outcome: "failed", detail: { httpStatus: 403, graphCode: "Authorization_RequestDenied", message: "Insufficient privileges", endpoint: "/v1.0/policies/authenticationMethodsPolicy", apiVersion: "v1.0", pagesCompleted: null, startedAt: null, completedAt: null },
    diagnosis: { diagnosis: "missing-scope", reason: "Policy.Read.All is not consented", original: { httpStatus: 403, graphCode: "Authorization_RequestDenied" } } }),
  ct("retentionLabel", "failed", { criticality: "tier2", outcome: "partial", itemCount: 17, detail: { httpStatus: 504, graphCode: "GatewayTimeout", message: "page 4 timed out", endpoint: "/beta/security/labels/retentionLabels", apiVersion: "beta", pagesCompleted: 3, startedAt: null, completedAt: null } }),
  ct("crossTenantAccessPolicyPartner", "protected", { reportStatus: "never-collected", outcome: "not-requested", lastCollectedAt: null, itemCount: null, detail: null, observation: null }),
  ct("managedDevice", "not-covered", { adapter: null, itemCount: null, lastCollectedAt: null, outcome: null, detail: null, fidelity: { declared: null, measured: null, verifiedAt: null }, criticality: "tier3", blastRadius: null, declaredEndpoint: null, writeCapability: null, observation: null }),
];
const COVERAGE: CoverageData = { generatedAt: now, snapshot: { id: "5a2be911-0000-4000-8000-000000000002", status: "complete", startedAt: now, completedAt: now },
  summary: { covered: 6, failed: 2, notCovered: 1, neverCollected: 1, stale: 1, total: COVERAGE_TYPES.length }, types: COVERAGE_TYPES };
const schedule = (id: string, job_kind: string, tier: string | null, cadence: Schedule["cadence"], extra: Partial<Schedule> = {}): Schedule => ({
  id, job_kind, tier, cadence, cron_override: null, enabled: true, next_due_at: "2026-10-02T10:00:00Z", last_job_id: null, last_run_at: null, last_status: null, last_error: null, ...extra,
});
const SCHEDULES: Schedule[] = [
  schedule("5c4e0000-0000-4000-8000-000000000001", "collect", "tier1", { every: "hour", n: 1, atTime: null }, { last_job_id: "a1", last_run_at: "2026-10-02T09:00:00Z", last_status: "succeeded" }),
  schedule("5c4e0000-0000-4000-8000-000000000002", "collect", "tier2", { every: "day", n: 1, atTime: "00:00" }, { next_due_at: "2026-10-03T00:00:00Z", last_job_id: "a4", last_run_at: "2026-10-02T00:00:00Z", last_status: "failed", last_error: "Graph 429: throttled after 5 retries" }),
  schedule("5c4e0000-0000-4000-8000-000000000003", "collect", "tier3", { every: "week", n: 1, atTime: "00:00" }, { cron_override: "0 0 * * 1", next_due_at: "2026-10-05T00:00:00Z" }),
  schedule("5c4e0000-0000-4000-8000-000000000004", "prune", null, { every: "day", n: 1, atTime: "00:00" }, { next_due_at: "2026-10-03T00:00:00Z" }),
  schedule("5c4e0000-0000-4000-8000-000000000005", "offsite", null, { every: "day", n: 1, atTime: "05:00" }, { enabled: false, next_due_at: "2026-10-03T05:00:00Z" }),
];

// Roadmap task-110: measured load estimates as engine/schedules/forecast.mjs returns them.
const presentation = (runs: [string, string, boolean][]): ScheduleForecast["presentation"] => ({
  timeZone: "Europe/Paris", timeZoneFallback: false, scheduling: "UTC",
  runs: runs.map(([at, local, businessHours]) => ({ at, local, businessHours })), inBusinessHours: runs.filter((run) => run[2]).length,
});
const WINDOW = { from: "2026-09-18T12:00:00.000Z", to: "2026-10-02T12:00:00.000Z", firstSample: "2026-09-18T13:01:00.000Z", lastSample: "2026-10-02T09:01:00.000Z" };
const FORECASTS: ScheduleForecast[] = [
  { scheduleId: "5c4e0000-0000-4000-8000-000000000001", jobKind: "collect", tier: "tier1", advisory: true, guarantee: false, status: "warning", reason: null,
    floorMs: 900000, runsPerDay: 24, intervalMs: 3600000, samples: 312, minSamples: 3, unmeasuredRuns: 24, window: WINDOW, confidence: "high",
    estimate: { requestsPerRun: { median: 48, p90: 61, max: 90 }, projectedRequestsPerDay: 1464, throttleRatio: 0.064, throttledRuns: 140, durationMs: { median: 41000, p90: 73000 },
      workloads: { directory: { requests: 14976, throttles: 958, runs: 312 } } },
    warnings: [{ code: "throttle-heavy", acknowledged: false, throttleRatio: 0.064, throttledRuns: 140, neededIntervalMs: 7200000 }],
    proposal: { cadence: { every: "hour", n: 2, atTime: null }, intervalMs: 7200000, floorMs: 900000, unchanged: false, cappedAtMaximum: false },
    acknowledgement: null,
    presentation: presentation([["2026-10-02T10:00:00.000Z", "Fri 12:00", true], ["2026-10-02T11:00:00.000Z", "Fri 13:00", true], ["2026-10-02T12:00:00.000Z", "Fri 14:00", true], ["2026-10-02T13:00:00.000Z", "Fri 15:00", true], ["2026-10-02T14:00:00.000Z", "Fri 16:00", true]]) },
  { scheduleId: "5c4e0000-0000-4000-8000-000000000002", jobKind: "collect", tier: "tier2", advisory: true, guarantee: false, status: "ok", reason: null,
    floorMs: 900000, runsPerDay: 1, intervalMs: 86400000, samples: 14, minSamples: 3, unmeasuredRuns: 0, window: WINDOW, confidence: "medium",
    estimate: { requestsPerRun: { median: 380, p90: 412, max: 455 }, projectedRequestsPerDay: 412, throttleRatio: 0, throttledRuns: 0, durationMs: { median: 260000, p90: 300000 },
      workloads: { directory: { requests: 4100, throttles: 0, runs: 14 }, intune: { requests: 1220, throttles: 0, runs: 14 } } },
    warnings: [], proposal: null, acknowledgement: null,
    presentation: presentation([["2026-10-03T00:00:00.000Z", "Sat 02:00", false], ["2026-10-04T00:00:00.000Z", "Sun 02:00", false], ["2026-10-05T00:00:00.000Z", "Mon 02:00", false]]) },
  { scheduleId: "5c4e0000-0000-4000-8000-000000000003", jobKind: "collect", tier: "tier3", advisory: true, guarantee: false, status: "unknown", reason: "insufficient-samples",
    floorMs: 900000, runsPerDay: 1 / 7, intervalMs: 604800000, samples: 2, minSamples: 3, unmeasuredRuns: 1, window: WINDOW, confidence: null,
    estimate: null, warnings: [], proposal: null, acknowledgement: null,
    presentation: presentation([["2026-10-05T00:00:00.000Z", "Mon 02:00", false]]) },
];
// Tier 2's slow runs were accepted by an operator: still listed, no longer driving the verdict.
const ACKNOWLEDGED: ScheduleForecast = { ...FORECASTS[1], status: "warning",
  warnings: [{ code: "overlap", acknowledged: true, durationP90Ms: 72000000, neededIntervalMs: 144000000 }],
  proposal: { cadence: { every: "day", n: 2, atTime: "00:00" }, intervalMs: 172800000, floorMs: 900000, unchanged: false, cappedAtMaximum: false },
  acknowledgement: { codes: ["overlap"], acknowledgedBy: "a11c0000-0000-4000-8000-0000000000a1", acknowledgedByName: "ops@contoso.com", acknowledgedAt: "2026-10-01T08:30:00Z", samples: 14 } };
const SCHEDULE_FORECASTS = [FORECASTS[0], ACKNOWLEDGED, FORECASTS[2]];

const header = (section: NavSection, title: string, description: string, marker?: string) =>
  <PageHeader description={description} generatedAt={now} marker={marker} section={section} title={title} />;

const trend = [3, 1, 0, 0, 2, 5, 4, 1, 0, 0, 0, 6, 9, 3, 2, 1, 0, 0, 4, 2, 2, 1, 0, 0, 7, 12, 5, 3, 2, 4];
const ALERTS: DashboardData["alerts"][] = [
  [
    { severity: "critical", title: "2 Conditional Access changes could lock out administrators", detail: "They could block sign-in for administrators. Review them before the next backup." },
    { severity: "warning", title: "3 configuration types are out of date", detail: "They were backed up successfully, but not recently enough for how critical they are. Run a backup." },
  ],
  [{ severity: "warning", title: "3 configuration types are out of date", detail: "They were backed up successfully, but not recently enough for how critical they are. Run a backup." }],
  [],
];
// Task-129: the three headline states the contract names, as the engine returns them.
const HEADLINE_COUNTS = { backedUp: 52, restorable: 48, failing: 0, failed: 0, stale: 0, neverCollected: 0 };
const HEADLINES: DashboardData["headline"][] = [
  { state: "collection", tone: "attention", headline: "Backups need attention", sentence: "4 configuration types failed their last backup.", action: { label: "Review backups", href: "/protect" }, counts: { ...HEADLINE_COUNTS, backedUp: 48, failing: 4, failed: 4 }, lastProvenRestoreAt: "2026-09-20T14:00:00Z", failingSince: null },
  { state: "unproven", tone: "attention", headline: "Backed up", sentence: "KEEL backs up 52 configuration types. No restore has been proven on this tenant yet.", action: { label: "Plan a test restore", href: "/restore" }, counts: HEADLINE_COUNTS, lastProvenRestoreAt: null, failingSince: null },
  { state: "proven", tone: "good", headline: "Protected", sentence: "KEEL can restore 48 of 52 configuration types today. Last proven restore: 20 Sept 2026.", action: null, counts: HEADLINE_COUNTS, lastProvenRestoreAt: "2026-09-20T14:00:00Z", failingSince: null },
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
    headline: HEADLINES[posture],
  };
}

// Task-71: an open incident whose newest snapshot captured the attack. The engine
// recommends the newest CLEARED snapshot, not the newest one. Every reference is a
// resolved name, as the portal readers return it.
const INVESTIGATOR = { kind: "person", id: "3f9c2b1e-0000-4000-8000-0000000000aa", name: "investigator@contoso.example", href: "/principals" };
const SNAP_BAD = "93c41e07-0000-4000-8000-000000000003";
const SNAP_GOOD = "5a2be911-0000-4000-8000-000000000002";
const SNAP_OLD = "0f7d3c52-0000-4000-8000-000000000001";
const snapshotRef = (id: string, name: string) => ({ kind: "snapshot", id, name, href: `/restore?snapshot=${id}` });
const INCIDENT: IncidentDetail = {
  incident: { id: "1c1d0000-0000-4000-8000-000000000071", title: "Admin consent phishing", owner: INVESTIGATOR, status: "open", openedAt: "2026-10-01T08:10:00Z", closedAt: null },
  intervals: [{ id: "7e000000-0000-4000-8000-000000000071", startsAt: "2026-09-30T22:40:00Z", endsAt: null, reason: "First malicious sign-in (risky sign-in report)", recordedBy: INVESTIGATOR }],
  pins: [{ id: "9b000000-0000-4000-8000-000000000071", snapshotId: SNAP_GOOD, reason: "Last known good before the attack", pinnedBy: INVESTIGATOR, pinnedAt: "2026-10-01T08:30:00Z" }],
  points: [
    {
      snapshotId: SNAP_BAD, snapshot: snapshotRef(SNAP_BAD, "Snapshot of 1 Oct 2026, 06:00 UTC"), observedFrom: "2026-10-01T05:55:00Z", observedTo: "2026-10-01T06:00:00Z",
      inCompromiseWindow: true, status: "unsuitable", stale: false, pinned: false,
      reasons: ["observed during a compromise interval", "assessed compromised (v1)"],
      assessment: { version: 1, verdict: "compromised", exclusions: [], assessedBy: INVESTIGATOR, assessedAt: "2026-10-01T09:00:00Z", fingerprint: "3c".repeat(32) },
    },
    {
      snapshotId: SNAP_GOOD, snapshot: snapshotRef(SNAP_GOOD, "Snapshot of 30 Sept 2026, 06:00 UTC"), observedFrom: "2026-09-30T05:55:00Z", observedTo: "2026-09-30T06:00:00Z",
      inCompromiseWindow: false, status: "qualified", stale: false, pinned: true,
      reasons: ["assessed clean with 1 malicious-field exclusion(s) (v2)"],
      assessment: {
        version: 2, verdict: "clean",
        exclusions: [{ naturalKey: "servicePrincipal:Mail Sync Helper", field: null, reason: "Consent granted by the attacker on 29 Sept", displayName: "Mail Sync Helper" }],
        assessedBy: INVESTIGATOR, assessedAt: "2026-10-01T09:20:00Z", fingerprint: "a2".repeat(32),
      },
    },
    {
      snapshotId: SNAP_OLD, snapshot: snapshotRef(SNAP_OLD, "Snapshot of 29 Sept 2026, 06:00 UTC"), observedFrom: "2026-09-29T05:55:00Z", observedTo: "2026-09-29T06:00:00Z",
      inCompromiseWindow: false, status: "unassessed", stale: false, pinned: false, reasons: ["not assessed for this incident"], assessment: null,
    },
  ],
  recommended: SNAP_GOOD,
};

// Task-76: read setup paused on the one step only the operator can do; restore
// setup not started and not checked.
const SETUP_RUN = "5e7a" + "0b".repeat(30);
const setupStep = (id: string, kind: SetupState["scopes"][number]["steps"][number]["kind"], identity: "collector" | "restorer", name: string, action: string, progress: SetupState["scopes"][number]["steps"][number]["progress"], workload: string | null = null, scopes: string[] = []) =>
  ({ id, kind, identity, workload, name, action, requiredScopes: scopes, missingScopes: scopes, manual: kind === "workload-rbac" || kind === "pim-activation", progress });
const READ_SCOPES = ["DeviceManagementConfiguration.Read.All", "Group.Read.All", "Policy.Read.All", "RoleManagement.Read.Directory", "User.Read.All"];
const SETUP: SetupState = {
  generatedAt: now,
  canCheck: false,
  canProvision: true,
  collect: { allowed: false, basis: "read-access-unconfirmed", missing: ["keel-collector", "keel-collector admin consent", "Read Only Operator", "keel.collect"] },
  firstCollection: null,
  scopes: [
    {
      scope: "read", workloads: ["entra-collect", "intune-collect"], observed: true,
      run: { artifactId: SETUP_RUN, state: "waiting-for-you", workloads: ["entra-collect", "intune-collect"], approvedBy: "8c1e0000-0000-4000-8000-0000000000a1", approvedByName: "Marouane", approvedAt: "2026-10-02T07:40:00Z", lastEventAt: "2026-10-02T07:40:02Z", resumableByViewer: true, build: "keel-2026.10.03", qualificationMode: "live-qualified" },
      steps: [
        setupStep("step-1a2b3c4d5e6f7a80", "registration", "collector", "keel-collector", "create-registration", "not-started", null, READ_SCOPES),
        setupStep("step-1a2b3c4d5e6f7a81", "graph-permission", "collector", "keel-collector admin consent", "grant-consent", "not-started", null, READ_SCOPES),
        setupStep("step-1a2b3c4d5e6f7a82", "workload-rbac", "collector", "Read Only Operator", "assign-workload-role", "waiting-for-you", "intune-collect"),
        setupStep("step-1a2b3c4d5e6f7a83", "keel-app-permission", "collector", "keel.collect", "configure-keel-permission", "not-started"),
      ],
    },
    {
      scope: "restore", workloads: ["entra-restore"], observed: false, run: null, planId: "plan-9f8e7d6c5b4a3921",
      steps: [
        setupStep("step-2a2b3c4d5e6f7a80", "registration", "restorer", "keel-restorer", "create-registration", "not-checked", null, ["Group.ReadWrite.All", "Policy.ReadWrite.ConditionalAccess", "RoleManagement.ReadWrite.Directory"]),
        setupStep("step-2a2b3c4d5e6f7a81", "graph-permission", "restorer", "keel-restorer admin consent", "grant-consent", "not-checked", null, ["Group.ReadWrite.All", "Policy.ReadWrite.ConditionalAccess", "RoleManagement.ReadWrite.Directory"]),
        setupStep("step-2a2b3c4d5e6f7a82", "pim-activation", "restorer", "Privileged Role Administrator", "pim-activate", "not-checked", "entra-restore"),
        setupStep("step-2a2b3c4d5e6f7a83", "keel-app-permission", "restorer", "keel.restore", "configure-keel-permission", "not-checked"),
      ],
    },
  ],
};
const setupVerdictFixture = setupVerdict(SETUP);

// Task-83: an overdue, escalated alert; an acknowledged one; a resolved one.
const alertEntry = (id: string, occurrence: number, fromState: AlertItem["state"] | null, toState: AlertItem["state"], reason: string, at: string, actorName: string | null = null) =>
  ({ id, occurrence, fromState, toState, reason, actor: actorName ? "8c1e0000-0000-4000-8000-0000000000a1" : "condition:drift-detect", actorName, at, eventId: null });
const INBOX_ALERTS: AlertItem[] = [
  {
    id: "a1e70000-0000-4000-8000-000000000001", resourceKey: "conditionalAccessPolicy:Block legacy auth", control: "baseline", condition: "drift",
    state: "reopened", conditionActive: true, severity: "warning", occurrence: 2, firstOpenedAt: "2026-09-30T08:00:00Z",
    occurrenceStartedAt: "2026-10-02T08:10:00Z", lastFiringAt: "2026-10-02T09:10:00Z", ackDeadlineAt: "2026-10-02T09:10:00Z",
    acknowledgedAt: null, acknowledgedByName: null, owner: { id: "8c1e0000-0000-4000-8000-0000000000a1", name: "Marouane" },
    escalated: true, escalationError: null, cause: { changeType: "modified", resourceType: "conditionalAccessPolicy", snapshotId: "5a9f0000-0000-4000-8000-000000000031" },
    lastEventId: "drift:5a9f0000-0000-4000-8000-000000000031:conditionalAccessPolicy:Block legacy auth",
    history: [
      alertEntry("1", 1, null, "open", "condition-firing", "2026-09-30T08:00:00Z"),
      alertEntry("2", 1, "open", "acknowledged", "acknowledged", "2026-09-30T08:20:00Z", "Marouane"),
      alertEntry("3", 1, "acknowledged", "resolved", "condition-resolved", "2026-10-01T08:00:00Z"),
      alertEntry("4", 2, "resolved", "reopened", "condition-recurred", "2026-10-02T08:10:00Z"),
      alertEntry("5", 2, "reopened", "reopened", "escalated-ack-deadline-missed", "2026-10-02T09:10:00Z"),
    ],
  },
  {
    id: "a1e70000-0000-4000-8000-000000000002", resourceKey: "group:Finance", control: "baseline", condition: "drift",
    state: "open", conditionActive: true, severity: "warning", occurrence: 1, firstOpenedAt: "2026-10-02T09:30:00Z",
    occurrenceStartedAt: "2026-10-02T09:30:00Z", lastFiringAt: "2026-10-02T09:30:00Z", ackDeadlineAt: null,
    acknowledgedAt: null, acknowledgedByName: null, owner: null, escalated: false, escalationError: null,
    cause: { changeType: "removed", resourceType: "group", snapshotId: "5a9f0000-0000-4000-8000-000000000032" },
    lastEventId: "drift:5a9f0000-0000-4000-8000-000000000032:group:Finance",
    history: [alertEntry("6", 1, null, "open", "condition-firing", "2026-10-02T09:30:00Z")],
  },
  {
    id: "a1e70000-0000-4000-8000-000000000003", resourceKey: "group:Break-glass admins", control: "baseline", condition: "drift",
    state: "resolved", conditionActive: false, severity: "critical", occurrence: 1, firstOpenedAt: "2026-09-28T10:00:00Z",
    occurrenceStartedAt: "2026-09-28T10:00:00Z", lastFiringAt: "2026-09-28T10:00:00Z", ackDeadlineAt: "2026-09-28T10:30:00Z",
    acknowledgedAt: null, acknowledgedByName: null, owner: { id: "8c1e0000-0000-4000-8000-0000000000a1", name: "Marouane" },
    escalated: false, escalationError: null, cause: { changeType: "modified", resourceType: "group", snapshotId: null },
    lastEventId: "drift-clear:5a9f0000-0000-4000-8000-000000000030:group:Break-glass admins",
    history: [
      alertEntry("7", 1, null, "open", "condition-firing", "2026-09-28T10:00:00Z"),
      alertEntry("8", 1, "open", "resolved", "resolved-by-operator", "2026-09-28T10:12:00Z", "Marouane"),
    ],
  },
];

function Page({ path, jobs, posture }: { path: string; jobs: Job[]; posture: number }) {
  const active = jobs.some((item) => item.status === "running" || item.status === "queued");
  switch (path) {
    case "/": return <DashboardView data={dashboard(posture)} pendingApprovals={2} />;
    case "/activity": return <>{header("Activity", "Activity", "What KEEL has done and who decided what, newest first.")}
      <Verdict text={activityVerdict(jobs, now)} tone={jobs.some((item) => item.status === "failed") ? "attention" : "good"} />
      <div data-layer="explanation">
        <IntegrityNote integrity={{ ok: true, status: "verified", anchoredThroughSeq: "18200", unanchoredRecords: 4 }} />
        <ActivityTimeline items={mergeActivity(jobs, EVIDENCE)} now={now} people={{ "marouanedefili@gmail.com": { kind: "person", id: "marouanedefili@gmail.com", name: "marouanedefili@gmail.com", href: null } }} />
        <JobRefresher active={active} />
      </div></>;
    case "/protect": {
      const verdict = protectVerdict(COVERAGE, now);
      return <>{header("Protect", "Protect", "Whether every configuration type is being backed up, how often, and whether KEEL can put it back.")}
        <Verdict text={verdict.text} tone={verdict.tone} />
        <div data-layer="explanation">
          <BackupControls canEditSchedules disabled={false} tiers={tierSummaries(SCHEDULES, now)} />
          <ProblemList disabled={false} problems={protectProblems(COVERAGE, now)} />
          <CoverageReport data={COVERAGE} now={now} />
          <JobTable headingId="backup-jobs" jobs={jobs.filter((item) => item.kind === "backup")} kicker="Recent" now={now} title="On-demand backups" />
        </div></>;
    }
    case "/schedules": {
      const verdict = schedulesVerdict(SCHEDULES, now, SCHEDULE_FORECASTS);
      return <>{header("Protect", "Schedules", "When KEEL backs up each tier and runs its upkeep. Times are in UTC.")}
        <Verdict text={verdict.text} tone={verdict.tone} />
        <div data-layer="explanation"><ScheduleTable canEdit deferrals={[]} forecasts={SCHEDULE_FORECASTS} now={now} schedules={SCHEDULES} /></div></>;
    }
    case "/restore": return <>{header("Restore", "Restore", "Put configuration back from a snapshot. Anything it depends on comes with it, and nothing changes until someone else approves.")}
      <RestoreSelection canApprove canRestore resources={[
        ...Object.keys(DEPENDS),
        "group:Break-glass admins", "group:All managed devices", "namedLocation:HQ egress", "authenticationStrength:Phishing-resistant", "group:Finance", "namedLocation:Branch offices",
      ].map((naturalKey) => ({ naturalKey, resourceType: naturalKey.split(":")[0], blastRadius: naturalKey.startsWith("conditional") ? "tenant-lockout" : naturalKey.startsWith("group") ? "access-affecting" : "cosmetic" })) as never}
        snapshotId="snap-1" snapshots={[{ id: "snap-1", startedAt: "2026-10-02T09:01:00Z", completedAt: "2026-10-02T09:12:00Z", resourceCount: 4812 } as never]} />
      <div data-layer="explanation"><JobTable headingId="restore-jobs-heading" jobs={jobs.filter((item) => item.kind.startsWith("restore"))} kicker="Recent" now={now} title="Restore jobs" /></div></>;
    case "/incidents": return <>{header("Restore", "Incidents", "During a security incident, restore from a snapshot an investigator has checked, not simply the newest one.", "Actionable")}
      <IncidentRecovery canInvestigate incidents={[INCIDENT.incident, { id: "1c1d0000-0000-4000-8000-000000000070", title: "Lost break-glass token (drill)", owner: INVESTIGATOR, status: "closed", openedAt: "2026-09-12T10:00:00Z", closedAt: "2026-09-13T16:00:00Z" }]} now={now} selected={INCIDENT} /></>;
    case "/drift": {
      const verdict = changesVerdict(DRIFT, BASELINES[0].setAt, now);
      return <>{header("Changes", "Changes", "What changed in the tenant since the active baseline, and what to do about each change.")}
        <Verdict text={verdict.text} tone={verdict.tone} />
        <div data-layer="explanation">
          <BaselineContext baseline={BASELINES[0]} now={now} />
          <DriftTable capabilities={["read", "dispose-accept", "remediate"]} items={DRIFT} now={now} />
        </div></>;
    }
    case "/jobs/a4": { const detail = jobs.find((item) => item.id === "a4")!; return <>{header("Activity", "Job", "What this job did and how it ended.")}<Verdict text={jobVerdict(detail, now)} tone="critical" /><a className="text-link back-link" href="#/activity"><span aria-hidden="true">←</span> All activity</a><JobDetail job={detail} now={now} /></>; }
    case "/jobs/r9": { const detail = { ...jobs.find((item) => item.id === "a3")!, id: "r9", kind: "restore", params: { artifactId: "7f3c0000-0000-4000-8000-000000000011", mode: "enforce" }, result: { applied: 2, skipped: 0 }, references: refs("marouanedefili@gmail.com", { plan: PLAN_REF }) }; return <>{header("Activity", "Job", "What this job did and how it ended.")}<Verdict text={jobVerdict(detail, now)} /><a className="text-link back-link" href="#/activity"><span aria-hidden="true">←</span> All activity</a><JobDetail job={detail} now={now} /><RecoveryCompletion canComplete restoreRef="7f3c0000-0000-4000-8000-000000000009" /></>; }
    case "/jobs/r10": { const detail = { ...jobs.find((item) => item.id === "a4")!, id: "r10", kind: "restore", params: { artifactId: "7f3c0000-0000-4000-8000-000000000010", mode: "enforce" }, error: "Graph 400: the update to Finance was rejected", references: refs("marouanedefili@gmail.com", { plan: { ...PLAN_REF, id: "7f3c0000-0000-4000-8000-000000000010" } }) }; return <>{header("Activity", "Job", "What this job did and how it ended.")}<Verdict text={jobVerdict(detail, now)} tone="critical" /><a className="text-link back-link" href="#/activity"><span aria-hidden="true">←</span> All activity</a><JobDetail job={detail} now={now} /><CompensationPanel canApprove canRestore failed restoreArtifactId="7f3c0000-0000-4000-8000-000000000010" /></>; }
    case "/jobs/a3": { const detail = { ...jobs.find((item) => item.id === "a3")!, result: { applied: 5, skipped: 0 } }; return <>{header("Activity", "Job", "What this job did and how it ended.")}<Verdict text={jobVerdict(detail, now)} /><a className="text-link back-link" href="#/activity"><span aria-hidden="true">←</span> All activity</a><JobDetail job={detail} now={now} /></>; }
    case "/approvals": return <>{header("Approvals", "Approvals", "Restores, roll-backs and baseline changes wait here for someone other than the requester.")}
      <Verdict text="2 requests are waiting for you." tone="attention" />
      <div data-layer="explanation"><ApprovalInbox now={now}
      history={[{ id: "a9e10000-0000-4000-8000-000000000100", action: "remediate", params: { driftIds: ["dr3"] }, requestedBy: "8c1e0000-0000-4000-8000-0000000000b2", justification: null, status: "approved", decidedBy: "8c1e0000-0000-4000-8000-0000000000a1", decidedAt: "2026-10-01T17:02:00Z", reason: null, createdAt: "2026-10-01T16:40:00Z", expiresAt: "2026-10-02T16:40:00Z",
        references: { ...EMPTY_REFERENCES, people: { requested_by: personRef("8c1e0000-0000-4000-8000-0000000000b2", "ops@contoso.com"), decided_by: personRef("8c1e0000-0000-4000-8000-0000000000a1", "marouanedefili@gmail.com") }, changes: [{ kind: "change", id: "dr3", name: null, readable: true, naturalKey: "group:Finance", changeType: "modified", blastRadius: "access-affecting" }] } }]}
      pending={[
        { id: "a9e10000-0000-4000-8000-000000000101", action: "restore", params: { artifactId: PLAN_REF.id }, requestedBy: "8c1e0000-0000-4000-8000-0000000000b2", justification: "Roll back CA policy edit from incident INC-2291", status: "pending", decidedBy: null, decidedAt: null, reason: null, createdAt: now, expiresAt: "2026-10-03T09:40:00Z",
          references: { ...EMPTY_REFERENCES, people: { requested_by: personRef("8c1e0000-0000-4000-8000-0000000000b2", "ops@contoso.com") }, plan: PLAN_REF } },
        { id: "a9e10000-0000-4000-8000-000000000102", action: "baseline-activate", params: { baselineId: BASELINES[0].id }, requestedBy: "8c1e0000-0000-4000-8000-0000000000b2", justification: "Post-migration golden state", status: "pending", decidedBy: null, decidedAt: null, reason: null, createdAt: now, expiresAt: "2026-10-03T12:00:00Z",
          references: { ...EMPTY_REFERENCES, people: { requested_by: personRef("8c1e0000-0000-4000-8000-0000000000b2", "ops@contoso.com") }, baseline: { kind: "baseline", id: BASELINES[0].id, name: "Post-migration golden state", readable: true } } },
      ]} /></div></>;
    case "/notifications": return <>{header("Settings", "Notifications", "Where KEEL sends alerts, which alerts go where, and what was sent.")}
      <Verdict text={notificationsVerdict(CHANNELS, DELIVERIES)} />
      <div data-layer="explanation">
        <NotificationConsole canConfiguration channels={CHANNELS}
          subscriptions={[{ id: "5b500000-0000-4000-8000-0000000000f1", channel_id: CHANNELS[0].id, event_glob: "drift.detected", min_severity: "warning" }, { id: "5b500000-0000-4000-8000-0000000000f2", channel_id: CHANNELS[1].id, event_glob: "*", min_severity: "critical" }]} />
        <DeliveryTable channels={CHANNELS} deliveries={DELIVERIES} now={now} />
      </div></>;
    case "/integrations": return <>{header("Settings", "Integrations", "Where KEEL copies its audit record: SIEM and webhook destinations.")}
      <Verdict text={integrationsVerdict(DESTINATIONS, DESTINATION_STATUSES)} tone="attention" />
      <div data-layer="explanation"><IntegrationConsole canConfiguration destinations={DESTINATIONS} statuses={DESTINATION_STATUSES} /></div></>;
    case "/baselines": return <>{header("Changes", "Baselines", "How the tenant should look: the reference every change is measured against.")}
      <Verdict text={baselinesVerdict(BASELINES[0], now)} />
      <div data-layer="explanation">
        <BaselineRegister baselines={BASELINES} canBaseline now={now} snapshots={CAPTURE_SOURCES} />
        <JobTable headingId="baseline-jobs-heading" jobs={jobs.filter((item) => item.kind.startsWith("baseline"))} kicker="Recent" now={now} title="Baseline jobs" />
      </div></>;
    case "/benchmarks": { const verdict = complianceVerdict(COMPLIANCE); return <>{header("Changes", "Compliance", "How the tenant measures against the controls KEEL checks, what each finding rests on, and where backups are kept.")}
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation"><ComplianceReport data={COMPLIANCE} now={now} /></div></>; }
    case "/principals": return <>{header("Settings", "People", "Who can use KEEL, their roles and what each can do. Principals include people and system accounts.")}
      <Verdict text="1 person can use KEEL; 1 can approve." />
      <div className="item-list" data-layer="explanation">
      <PrincipalDetails canRoles canUsers now={now} principal={{ id: "8c1e0000-0000-4000-8000-0000000000a1", email: "marouanedefili@gmail.com", display_name: "Marouane", disabled_at: null, capabilities: ["read", "approve", "users", "roles", "policies", "configuration"], role_grants: [{ id: "6a000000-0000-4000-8000-000000000001", role: "admin", active_from: "2026-09-01T00:00:00Z", active_until: null }, { id: "6a000000-0000-4000-8000-000000000002", role: "approver", active_from: "2026-09-01T00:00:00Z", active_until: null }] }} />
      <PrincipalDetails canRoles canUsers now={now} principal={{ id: "8c1e0000-0000-4000-8000-0000000000c3", email: "former.contractor@contoso.com", disabled_at: "2026-09-20T10:00:00Z", capabilities: [], role_grants: [{ id: "6a000000-0000-4000-8000-000000000003", role: "operator", active_from: "2026-06-01T00:00:00Z", active_until: "2026-09-20T10:00:00Z" }] }} /></div></>;
    case "/alerts": { const verdict = alertsVerdict(INBOX_ALERTS, now); return <>{header("Changes", "Alerts", "Changes that need someone: who owns each one, when it must be acknowledged, and what happened so far.")}
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation"><AlertInbox alerts={INBOX_ALERTS} canRespond now={now} /></div></>; }
    case "/setup": return <>{header("Settings", "Setup", "Connect KEEL to your Microsoft tenant: what is in place, what is waiting on you, and when the first backup can run.")}
      <Verdict text={setupVerdictFixture.text} tone={setupVerdictFixture.tone} />
      <div className="item-list" data-layer="explanation">
        {SETUP.scopes.map((setup) => <SetupProgress canCheck={SETUP.canCheck} canProvision={SETUP.canProvision} canStart key={setup.scope} now={now} setup={setup} />)}
      </div></>;
    case "/policies/p1": return <>{header("Settings", POLICY.name, "What this policy does, acting as whom, and what it last did.")}
      <Verdict text={`Running. ${policySentence(POLICY)}`} />
      <div data-layer="explanation">
        <a className="text-link back-link" href="#/policies"><span aria-hidden="true">←</span> All policies</a>
        <AutomationBanner halted={false} now={now} />
        <PolicyCard canEdit linkName={false} now={now} policy={POLICY} />
      </div></>;
    case "/policies": return <>{header("Settings", "Policies", "What KEEL does on its own when something changes, and the account it acts as.")}
      <Verdict text={policiesVerdict(POLICIES, false)} />
      <div data-layer="explanation">
        <AutomationBanner halted={false} now={now} />
        {POLICIES.map((policy) => <PolicyCard canEdit key={policy.id} now={now} policy={policy} />)}
      </div></>;
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
        <CommandPalette canApprove canConfigure canPolicies canRead canUsers />
        <NavLinks canApprove canConfigure canPolicies canRead canUsers pendingApprovals={2} />
        <div className="operator-context">
          <span className="auth-state"><span aria-hidden="true" className="auth-dot" /> Authenticated</span>
          <span className="operator-email">marouanedefili@gmail.com</span>
          <span className="access-label">{accessSummary(["read", "approve", "restore", "rollback", "remediate", "investigate", "collect", "backup", "policies", "users", "roles", "configuration"])}</span>
          <ThemeToggle initial="system" />
        </div>
      </aside>
      <main className="workspace" id="main-content">
        <SectionTabs canApprove canConfigure canPolicies canRead canUsers />
        <div className="page-transition" key={loading ? "loading" : `${path}:${posture}`}>
          {loading ? <PageSkeleton /> : <Page jobs={jobs} path={path} posture={posture} />}
        </div>
      </main>
    </div>
    <Toaster />
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
