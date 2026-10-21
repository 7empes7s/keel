import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { type NavSection } from "@/components/nav-links";
import { AppShell } from "@/components/shell/app-shell";
import { KitPage } from "./kit";
import { EMPTY_PREFS } from "@/lib/menu-prefs";
import { Toaster } from "@/components/toaster";
import { PageHeader } from "@/components/page-header";
import { JobTable } from "@/components/job-table";
import { JobRefresher } from "@/components/job-refresher";
import { PageSkeleton } from "@/components/ui/skeleton";
import { BackUpNow, TierStrip } from "@/components/backup-controls";
import { ProtectCoverage } from "@/components/protect-coverage";
import { ScheduleTable, schedulesVerdict } from "@/components/schedule-table";
import { protectStatus, protectVerdict, protectVerdictDetail, tierSummaries } from "@/lib/protect-view";
import type { Schedule, ScheduleForecast } from "@/lib/schedules";
import { ApprovalInbox } from "@/components/approval-inbox";
import type { ApprovalRequestRecord } from "@/lib/approval-inbox";
import { NotificationsPage } from "@/components/notifications/notifications-page";
import { IntegrationConsole } from "@/components/integration-console";
import { ActivityPage } from "@/components/activity/activity-page";
import { activityCounts, activityStatus } from "@/lib/activity-view";
import { ApprovedSetup } from "@/components/baselines/approved-setup";
import { RecentWork } from "@/components/baselines/recent-work";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ChangeList } from "@/components/baselines/change-list";
import { CreateWizard } from "@/components/baselines/create-wizard";
import { quickComparisons, setupStatus, setupVerdict as approvedVerdict, typeService } from "@/lib/baselines-view";
import { toDay } from "@/lib/date-range";
import { Verdict } from "@/components/verdict";
import { Icon } from "@/components/shell/icons";
import { PeoplePage } from "@/components/people/people-page";
import { PoliciesPage } from "@/components/policies/policies-page";
import { PolicyPage } from "@/components/policies/policy-page";
import { usePathname, useSearchParams } from "next/navigation";
import { RestoreSelection } from "@/components/restore-selection";
import type { RestoreChange } from "@/lib/restore-changes";
import { lastRestoreTile } from "@/lib/restore-view";
import { changesVerdict } from "@/lib/changes-view";
import { JobDetail, jobVerdict } from "@/components/job-detail";
import { RecoveryCompletion } from "@/components/recovery-completion";
import { CompensationPanel } from "@/components/compensation-panel";
import { ContentEffectsPanel, type ContentEffect } from "@/components/content-effects";
import { IncidentRecovery } from "@/components/incident-recovery";
import type { IncidentDetail } from "@/lib/portal-data";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import type { BaselineCapture, BaselineChanges, BaselineRecord, ComplianceData, CoverageData, CoverageType, DashboardData, DriftRecord } from "@/lib/types";
import { ComplianceReport } from "@/components/compliance-report";
import { complianceVerdict } from "@/lib/compliance-view";
import { accessSummary } from "@/lib/presentation";
import { EMPTY_REFERENCES, type RowReferences } from "@/lib/sentences";
import { integrationsPageVerdict } from "@/lib/integrations-view";
import { ServiceNowPanel } from "@/components/servicenow-panel";
import type { ServiceNowStatus } from "@/lib/servicenow";
import type { ActivationPreview, Policy, PolicyAction } from "@/lib/policies";
import { RULE_KINDS, RULE_STATES, ruleCounts, ruleKind, ruleState, rulesStatus } from "@/lib/policy-view";
import { peopleCounts, peopleStatus } from "@/lib/people-view";
import type { PrincipalView } from "@/lib/principals";
import { SetupProgress } from "@/components/setup-progress";
import { setupVerdict, type SetupState } from "@/lib/setup-view";
import { AlertInbox } from "@/components/alert-inbox";
import { alertsVerdict, type AlertItem } from "@/lib/alerts-view";
import { ReadinessView } from "@/components/readiness-view";
import { ResilienceView } from "@/components/resilience-view";
import { readinessVerdict, type Dimension, type ReadinessAccount, type ReadinessData } from "@/lib/readiness-view";
import { resilienceVerdict, type ResilienceData } from "@/lib/resilience-view";
import { ValueReportView } from "@/components/value-report-view";
import { valueVerdict, type ValueReport } from "@/lib/value-report-view";
import { AskView } from "@/components/ask-view";
import { askVerdict, type AskData, type GroundedAnswer } from "@/lib/ask-view";
import { ApproveIntentForm, IntentCard } from "@/components/change-intent";
import { CompareView } from "@/components/compare-view";
import { compareVerdict, type CompareData, type CompareResult, type CompareTenant } from "@/lib/compare-view";
import type { ActivityChanges } from "@/lib/changed-values";
import { changeIntentsVerdict, type ChangeIntent, type IntentCandidate } from "@/lib/change-intents-view";
import { SiteDetail, SiteList } from "@/components/site-permissions";
import { sitePermissionsFrom, siteName, siteVerdict, sitesVerdict, type SitePermissionsData } from "@/lib/site-permissions-view";
import { WorkloadServices } from "@/components/restore/workload-services";
import type { RestoreWorkload } from "@/lib/restore-workloads-view";

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
const HARNESS_PEOPLE = [
  { id: "8c1e0000-0000-4000-8000-0000000000a1", email: "marouanedefili@gmail.com", display_name: "Marouane Defili", disabled_at: null, capabilities: ["read", "approve", "users", "remediate"], role_grants: [] },
  { id: "8c1e0000-0000-4000-8000-0000000000a2", email: "amara.okafor@contoso.example", display_name: "Amara Okafor", disabled_at: null, capabilities: ["read", "approve"], role_grants: [] },
];
// People page: an admin who is also an approver (the only admin), an approver, an
// operator with a restorer role starting later, a viewer who is an operator for one part
// of the company, someone whose only role starts later, a disabled former contractor and
// Keel's scheduler.
const grant = (id: string, role: string, from: string, until: string | null = null, scope = "*", by: string | null = "8c1e0000-0000-4000-8000-0000000000a1", reason: string | null = null) => ({ id: `6a000000-0000-4000-8000-0000000000${id}`, role, active_from: from, active_until: until, granted_by: by, scope, reason });
const PEOPLE_PAGE: PrincipalView[] = [
  { id: "8c1e0000-0000-4000-8000-0000000000a1", email: "marouanedefili@gmail.com", display_name: "Marouane Defili", disabled_at: null, capabilities: ["read", "approve", "users", "roles", "policies", "configuration", "automation"], role_grants: [grant("01", "admin", "2026-09-01T00:00:00Z", null, "*", null), grant("02", "approver", "2026-09-01T00:00:00Z", null, "*", null)] },
  { id: "8c1e0000-0000-4000-8000-0000000000a2", email: "amara.okafor@contoso.example", display_name: "Amara Okafor", disabled_at: null, capabilities: ["approve"], role_grants: [grant("03", "approver", "2026-09-03T00:00:00Z")] },
  { id: "8c1e0000-0000-4000-8000-0000000000b3", email: "sam.ortiz@contoso.example", display_name: "Sam Ortiz", disabled_at: null, capabilities: ["collect", "backup", "baseline-create", "dispose-accept", "discover", "content-backup", "export"], role_grants: [grant("04", "operator", "2026-09-10T00:00:00Z"), grant("05", "restorer", "2026-10-06T00:00:00Z", "2026-10-20T23:59:59Z", "*", "8c1e0000-0000-4000-8000-0000000000a1", "Covers restores while Lee is away")] },
  { id: "8c1e0000-0000-4000-8000-0000000000b4", email: "lee.chen@contoso.example", display_name: "Lee Chen", disabled_at: null, capabilities: ["read"], entity_capabilities: { CONTOSO_FR: ["collect", "backup", "baseline-create", "dispose-accept", "discover", "content-backup", "export"] }, role_grants: [grant("06", "viewer", "2026-09-12T00:00:00Z"), grant("07", "operator", "2026-09-12T00:00:00Z", null, "entity:CONTOSO_FR")] },
  { id: "8c1e0000-0000-4000-8000-0000000000b5", email: "priya.nair@contoso.example", display_name: null, disabled_at: null, capabilities: [], role_grants: [grant("08", "viewer", "2026-10-05T00:00:00Z")] },
  { id: "8c1e0000-0000-4000-8000-0000000000c3", email: "former.contractor@contoso.com", disabled_at: "2026-09-20T10:00:00Z", capabilities: [], role_grants: [grant("09", "operator", "2026-06-01T00:00:00Z", "2026-09-20T10:00:00Z")] },
  { id: "8c1e0000-0000-4000-8000-0000000000d1", email: "scheduler@keel.internal", display_name: "KEEL scheduler", system_kind: "scheduler", disabled_at: null, capabilities: ["collect", "configuration"], role_grants: [] },
];
const NEW_PERSON = (body: { email: string; displayName?: string | null; role: string }): PrincipalView => ({ id: "8c1e0000-0000-4000-8000-0000000000e9", email: body.email, display_name: body.displayName ?? null, disabled_at: null, capabilities: body.role === "viewer" ? ["read"] : [], role_grants: [grant("99", body.role, "2026-10-02T09:40:00Z")] });
// The newest delivery on the Teams channel failed, so Settings says a channel is failing.
const HARNESS_DELIVERIES = [
  { id: "d-1", channel_id: "c-teams", channel_kind: "teams", status: "failed", event: { kind: "drift.detected", severity: "high" }, attempts: 5, last_error: "403", next_attempt_at: null },
  { id: "d-2", channel_id: "c-mail", channel_kind: "email", status: "delivered", event: { kind: "drift.detected", severity: "high" }, attempts: 1, last_error: null, next_attempt_at: null },
  { id: "d-3", channel_id: "c-teams", channel_kind: "teams", status: "delivered", event: { kind: "job.failed", severity: "medium" }, attempts: 1, last_error: null, next_attempt_at: null },
];

// Every call the pages make, for tests: fetch is answered in-page, so Playwright never
// sees a network request.
const HARNESS_CALLS: { url: string; method: string; body: string | null }[] = [];
(window as unknown as { __harnessCalls: typeof HARNESS_CALLS }).__harnessCalls = HARNESS_CALLS;

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  HARNESS_CALLS.push({ url: url.replace(/^https?:\/\/[^/]+/, ""), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
  // The menu's section statuses read the Overview's data; answer at once so every
  // screenshot shows them.
  if (url.endsWith("/api/dashboard")) return json(dashboard(0));
  // Settings' menu badge and the search's people and kinds of settings.
  // People: adding someone answers the new person; every change to a person succeeds.
  if (url.endsWith("/api/principals") && init?.method === "POST") return json({ principal: NEW_PERSON(JSON.parse(String(init.body))) }, 201);
  if (/\/api\/principals\/[^/]+\/(grant|revoke|disable|enable)$/.test(url)) return json({ result: {} }, 200);
  if (url.endsWith("/api/principals")) return json({ principals: HARNESS_PEOPLE, generatedAt: "2026-10-04T09:00:00Z" });
  if (url.includes("/api/deliveries")) return json({ deliveries: HARNESS_DELIVERIES, generatedAt: "2026-10-04T09:00:00Z" });
  if (url.endsWith("/api/coverage")) return json({ types: [{ type: "authenticationMethodsPolicy" }, { type: "conditionalAccessPolicy" }] });
  // Activity: what a row changed, setting by setting.
  if (url.includes("/api/activity/changes?")) return json({ changes: ACTIVITY_CHANGES[new URL(url, "http://harness").searchParams.get("job") ?? ""] ?? null });
  await new Promise((resolve) => setTimeout(resolve, url.includes("/selection") || url.includes("/completion") ? 350 : 800));
  if (url.includes("/api/actions/restore/completion/")) return json({ restoreRef: "r9", resources: completionResources() });
  // Task-92: the activation preview of policy p2, and a turn-on refused because the
  // run-as account's access changed after the preview.
  if (url.endsWith("/activation-preview")) return json({ preview: { ...ACTIVATION_PREVIEW, id: "9a0c0000-0000-4000-8000-000000000093" } }, 201);
  // Policies: turning a rule off or on and resuming it succeed; a new rule lands on p2's page.
  if (/\/api\/policies\/[^/]+\/(enabled|clear-pause)$/.test(url)) return json({ policy: {} });
  if (url.endsWith("/api/policies") && init?.method === "POST") return json({ policy: { id: "p2" } }, 201);
  if (url.endsWith("/activate")) return json({ error: "preview-stale", changed: ["grant"] }, 409);
  // Task-93: approving your own emergency change is refused; a revoke succeeds.
  if (url.endsWith("/api/change-intents")) return json({ error: "owner-is-approver" }, 409);
  if (url.includes("/api/change-intents/") && url.endsWith("/revoke")) return json({ intent: {}, settlement: { currentState: "matches-baseline", driftId: null } });
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
    // A group synced from on-premises is refused, with the guard's own coded reason.
    const guardRefusals = selected.filter((key) => key === "group:Finance").map((naturalKey) => ({ naturalKey, reason: "onPremisesSyncEnabled=true — source of authority is on-premises Active Directory, cloud-side restore is refused" }));
    return json({ selected, closureKeys: lastClosure, added: [...added].map(([naturalKey, reasons]) => ({ naturalKey, resourceType: naturalKey.split(":")[0], reasons })), unresolvedReferences: [], guardRefusals, missingRequirements: missing });
  }
  // The other services on Restore: mail flow's backups and objects, then its dry run.
  if (url.includes("/api/actions/restore/workload?")) {
    const params = new URL(url, "http://harness").searchParams;
    if (params.get("workload") === "exchange-mailbox-settings") return json({ choices: MAILBOX_CHOICES });
    return json({ choices: workloadChoicesFixture(params.get("collection")) });
  }
  if (url.endsWith("/api/actions/restore/workload/dry-run")) {
    jobPolls = 0;
    const body = JSON.parse(String(init?.body ?? "{}")) as { workload?: string; targets?: string[] };
    if (body.workload === "exchange-mailbox-settings") {
      const boxes = (body.targets ?? []).filter((key) => key !== "organization");
      return json({ runs: boxes.map((target, index) => ({ target, job: { id: `job-mb-${index}` }, artifactId: `mb000000-0000-4000-8000-00000000000${index}` })) }, 202);
    }
    return json({ runs: [{ target: null, job: { id: "job-wd-1" }, artifactId: "wd000000-0000-4000-8000-000000000001" }] }, 202);
  }
  if (url.includes("/api/actions/restore/dry-run/wd000000")) return json({ artifact: WORKLOAD_ARTIFACT });
  if (url.includes("/api/actions/restore/dry-run/mb000000")) return json({ artifact: mailboxArtifact(url.slice(-1)) });
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
  // Notifications: a test send answers with its queued delivery; the other writes just succeed.
  if (/\/api\/channels\/[^/]+\/test$/.test(url)) {
    const channelId = url.split("/").at(-2) ?? "";
    const channel = CHANNELS.find((entry) => entry.id === channelId);
    return json({ delivery: { id: `d0e10000-0000-4000-8000-00000000${String(Date.now()).slice(-4)}`, event: { kind: "test", severity: "notice" }, channel_id: channelId, channel_kind: channel?.kind ?? "webhook", status: "queued", attempts: 0, last_error: null, next_attempt_at: now, created_at: now } }, 202);
  }
  if (/\/api\/channels\/[^/]+\/(enable|disable)$/.test(url)) return json({ id: url.split("/").at(-2) });
  if (url.endsWith("/api/channels") && init?.method === "POST") return json({ channel: { id: "c4e10000-0000-4000-8000-0000000000c9", ...JSON.parse(String(init.body)), enabled: true } }, 201);
  if (url.endsWith("/api/subscriptions") && init?.method === "POST") return json({ subscription: { id: "5b500000-0000-4000-8000-0000000000f9", ...JSON.parse(String(init.body)) } }, 201);
  if (/\/api\/subscriptions\/[^/]+$/.test(url)) return json(init?.method === "DELETE" ? { id: url.split("/").at(-1) } : { subscription: { id: url.split("/").at(-1) } });
  if (url.endsWith("/api/escalation-rules") && init?.method === "POST") return json({ escalationRule: { id: "e5c10000-0000-4000-8000-0000000000e9" } }, 201);
  if (/\/api\/escalation-rules\/[^/]+\/(enable|disable)$/.test(url)) return json({ escalationRule: { id: url.split("/").at(-2) } });
  if (url.endsWith("/api/actions/restore/content-effects")) { contentEffectsApproved = true; return json({ approval: { id: "cea-1" } }); }
  // Approvals: the two-person restore records a first sign-off; everything else starts.
  if (/\/api\/approvals\/[^/]+\/approve$/.test(url)) return json(url.includes(TWO_PERSON_REQUEST) ? { job: null, signoffs: 1, requiredApprovals: 2 } : { job: { id: "a3" }, signoffs: 1, requiredApprovals: 1 }, 202);
  if (/\/api\/approvals\/[^/]+\/reject$/.test(url)) return json({ approvalRequest: { id: "rejected" } });
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
    after: { displayName: "Block legacy auth", state: "enabledForReportingButNotEnforced", conditions: { clientAppTypes: ["exchangeActiveSync", "other"], users: { includeUsers: ["All"], excludeGroups: ["Break-glass admins", "Finance"] } }, grantControls: { operator: "OR", builtInControls: ["block"] } },
    attribution: { verdict: "exact", reason: "audit-record-names-resource", actors: [{ kind: "user", id: "a71ce000-0000-4000-8000-0000000000a7", name: "Amara Okafor" }],
      evidence: [{ sourceEventId: "Directory_8f2c1d7a-4b3e-4f61-9a20-1c5d7e9b3a44", occurredAt: "2026-10-02T08:47:00Z", operation: "update", activity: "Update conditional access policy", fields: ["conditions", "state"] }],
      resourceObjectId: "c0a10000-0000-4000-8000-0000000000ca", window: { from: "2026-10-02T06:00:00Z", until: "2026-10-02T09:12:00Z" }, coverage: { audit: "covered", signIn: "covered" },
      route: { route: "central", reason: "cross-entity", approverCount: 2, routedAt: "2026-10-02T10:00:00Z" } } },
  { id: "dr2", naturalKey: "conditionalAccessPolicy:Require MFA for admins", resourceType: "conditionalAccessPolicy", changeType: "modified", blastRadius: "tenant-lockout", detectedAt: "2026-10-01T21:40:00Z",
    before: { state: "enabled", grantControls: { builtInControls: ["mfa"] }, sessionControls: { signInFrequency: { value: 4, type: "hours" } } },
    after: { state: "enabled", grantControls: { builtInControls: ["mfa"] }, sessionControls: { signInFrequency: { value: 24, type: "hours" } } } },
  { id: "dr3", naturalKey: "group:Finance", resourceType: "group", changeType: "modified", blastRadius: "access-affecting", detectedAt: "2026-10-01T15:02:00Z",
    before: { displayName: "Finance", membershipRule: null, mailEnabled: false, owners: ["cfo@contoso.com"] }, after: { displayName: "Finance", membershipRule: null, mailEnabled: true, owners: ["cfo@contoso.com", "temp.contractor@contoso.com"] },
    attribution: { verdict: "unknown", reason: "audit-retention-gap", actors: [], evidence: [], resourceObjectId: "f1a40000-0000-4000-8000-0000000000f1",
      window: { from: "2026-08-01T06:00:00Z", until: "2026-10-01T15:02:00Z" }, coverage: { audit: "retention-gap", signIn: "not-read" },
      route: { route: "entity", entityCode: "CREOS", approverCount: 1, routedAt: "2026-10-02T10:00:00Z" } } },
  { id: "dr4", naturalKey: "namedLocation:Branch offices", resourceType: "namedLocation", changeType: "added", blastRadius: "access-affecting", detectedAt: "2026-09-30T10:00:00Z", before: null, after: { displayName: "Branch offices", ipRanges: ["203.0.113.0/24"] } },
  { id: "dr5", naturalKey: "deviceConfiguration:Windows baseline", resourceType: "deviceConfiguration", changeType: "modified", blastRadius: "cosmetic", detectedAt: "2026-09-29T08:30:00Z",
    before: { description: "Corporate Windows baseline", passwordMinimumLength: 12 }, after: { description: "Corporate Windows baseline v2", passwordMinimumLength: 12 } },
  { id: "dr6", naturalKey: "group:Old project team", resourceType: "group", changeType: "removed", blastRadius: "cosmetic", detectedAt: "2026-09-28T12:00:00Z", before: { displayName: "Old project team" }, after: null },
  // Task 98: a change whose baseline copy was not kept; its earlier values are unknown.
  { id: "dr7", naturalKey: "namedLocation:HQ egress", resourceType: "namedLocation", changeType: "modified", blastRadius: "access-affecting", detectedAt: "2026-09-27T07:15:00Z", before: null, after: { displayName: "HQ egress", ipRanges: ["198.51.100.0/24"] } },
] as unknown as DriftRecord[];

// Task 98: the server's semantic comparison and linked records for each change, as
// engine/govern/semanticDrift.mjs returns them (the harness cannot run the engine).
const SEMANTIC: Record<string, NonNullable<DriftRecord["semantic"]>> = {
  dr1: { state: "compared", rules: "reviewed", total: 2, shown: 2, cosmetic: 1, groups: { behaviour: 2, fixed: 0, "unknown-before": 0 }, fields: [
    { path: "conditions.users.excludeGroups", kind: "changed", before: ["Break-glass admins"], after: ["Break-glass admins", "Finance"], impact: "behaviour" },
    { path: "state", kind: "changed", before: "enabled", after: "enabledForReportingButNotEnforced", impact: "behaviour" },
  ] },
  dr2: { state: "compared", rules: "reviewed", total: 1, shown: 1, cosmetic: 0, groups: { behaviour: 1, fixed: 0, "unknown-before": 0 }, fields: [
    { path: "sessionControls.signInFrequency.value", kind: "changed", before: 4, after: 24, impact: "behaviour" },
  ] },
  dr3: { state: "compared", rules: "reviewed", total: 2, shown: 2, cosmetic: 0, groups: { behaviour: 1, fixed: 1, "unknown-before": 0 }, fields: [
    { path: "mailEnabled", kind: "changed", before: false, after: true, impact: "fixed" },
    { path: "owners", kind: "changed", before: ["cfo@contoso.com"], after: ["cfo@contoso.com", "temp.contractor@contoso.com"], impact: "behaviour" },
  ] },
  dr4: { state: "added", rules: "reviewed", total: 0, shown: 0, cosmetic: 0, groups: { behaviour: 0, fixed: 0, "unknown-before": 0 }, fields: [] },
  dr5: { state: "compared", rules: "reviewed", total: 1, shown: 1, cosmetic: 0, groups: { behaviour: 1, fixed: 0, "unknown-before": 0 }, fields: [
    { path: "description", kind: "changed", before: "Corporate Windows baseline", after: "Corporate Windows baseline v2", impact: "behaviour" },
  ] },
  dr6: { state: "removed", rules: "reviewed", total: 0, shown: 0, cosmetic: 0, groups: { behaviour: 0, fixed: 0, "unknown-before": 0 }, fields: [] },
  dr7: { state: "unknown-before", rules: "reviewed", total: 2, shown: 2, cosmetic: 0, groups: { behaviour: 0, fixed: 0, "unknown-before": 2 }, fields: [
    { path: "displayName", kind: "unknown-before", after: "HQ egress", impact: "unknown-before" },
    { path: "ipRanges", kind: "unknown-before", after: ["198.51.100.0/24"], impact: "unknown-before" },
  ] },
};
const NO_LINKS = { findings: [], approvals: [], plans: [], mismatches: 0 };
const CHANGE_EVIDENCE: Record<string, NonNullable<DriftRecord["evidence"]>> = {
  dr1: {
    ownership: { state: "shared", entityCode: null, sharedWith: ["CREOS", "ENOVOS"], othersWithheld: false },
    observation: { state: "matches", snapshotId: "5a9f0000-0000-4000-8000-000000000031", at: "2026-10-02T09:12:00Z", versionId: "7e570000-0000-4000-8000-000000000001" },
    backup: { state: "matches", snapshotId: "0b5e0000-0000-4000-8000-0000000000c8", at: "2026-09-20T06:00:00Z", versionId: "7e570000-0000-4000-8000-000000000002" },
    findings: [{ evaluationId: "e7a10000-0000-4000-8000-0000000000e1", controlId: "keel-custom.ca.legacy-auth-blocked", title: "Legacy sign-in is blocked", verdict: "fail", exposed: true, link: "linked" }],
    approvals: [{ id: "a9e10000-0000-4000-8000-000000000101", action: "remediate", status: "pending", createdAt: "2026-10-02T09:30:00Z", decidedAt: null, expiresAt: "2026-10-03T09:30:00Z", job: null, others: 1, othersWithheld: false }],
    plans: [{ id: "7f3c0000-0000-4000-8000-000000000012", snapshotId: "0b5e0000-0000-4000-8000-0000000000c8", status: "completed", createdAt: "2026-10-02T09:35:00Z", link: "linked", outcome: null, others: 0, othersWithheld: false,
      approvals: [{ id: "a9e10000-0000-4000-8000-000000000102", action: "restore", status: "pending", createdAt: "2026-10-02T09:36:00Z", decidedAt: null, expiresAt: "2026-10-03T09:36:00Z", job: null, others: 0, othersWithheld: false }] }],
    mismatches: 0,
  },
  dr3: {
    ownership: { state: "owned", entityCode: "CREOS", sharedWith: [], othersWithheld: false },
    observation: { state: "matches", snapshotId: "5a9f0000-0000-4000-8000-000000000032", at: "2026-10-01T15:02:00Z", versionId: "7e570000-0000-4000-8000-000000000003" },
    backup: { state: "mismatch", snapshotId: "0b5e0000-0000-4000-8000-0000000000c8", at: "2026-09-20T06:00:00Z", versionId: "7e570000-0000-4000-8000-000000000004" },
    findings: [],
    approvals: [{ id: "a9e10000-0000-4000-8000-000000000100", action: "remediate", status: "approved", createdAt: "2026-10-01T16:40:00Z", decidedAt: "2026-10-01T17:02:00Z", expiresAt: "2026-10-02T16:40:00Z", job: { id: "a3", status: "succeeded" }, others: 0, othersWithheld: false }],
    plans: [{ id: "7f3c0000-0000-4000-8000-000000000011", snapshotId: "5a9f0000-0000-4000-8000-000000000030", status: "completed", createdAt: "2026-10-01T17:03:00Z", link: "mismatch", outcome: { state: "succeeded", at: "2026-10-01T17:10:00Z" }, others: 0, othersWithheld: false, approvals: [] }],
    mismatches: 2,
  },
  dr7: {
    ownership: { state: "unknown", entityCode: null, sharedWith: [], othersWithheld: false },
    observation: { state: "unchecked", snapshotId: "5a9f0000-0000-4000-8000-000000000027", at: "2026-09-27T07:15:00Z", versionId: null },
    backup: { state: "missing", snapshotId: null, at: null, versionId: null },
    ...NO_LINKS,
  },
};
const DRIFT_DECIDED = DRIFT.map((item) => ({ ...item, semantic: SEMANTIC[item.id], evidence: CHANGE_EVIDENCE[item.id] ?? {
  ownership: { state: "owned", entityCode: "CREOS", sharedWith: [], othersWithheld: false },
  observation: { state: "matches", snapshotId: "5a9f0000-0000-4000-8000-000000000033", at: item.detectedAt, versionId: null },
  backup: { state: item.changeType === "added" ? "not-in-baseline" : "matches", snapshotId: "0b5e0000-0000-4000-8000-0000000000c8", at: "2026-09-20T06:00:00Z", versionId: null },
  ...NO_LINKS,
} })) as DriftRecord[];
// Counts over DRIFT_DECIDED that reconcile: 2 + 3 + 2 changes, 3 + 2 + 1 settings.
const DRIFT_SUMMARY = {
  total: 7,
  byImpact: [{ blastRadius: "tenant-lockout", changes: 2, settings: 3 }, { blastRadius: "access-affecting", changes: 3, settings: 2 }, { blastRadius: "cosmetic", changes: 2, settings: 1 }],
  behaviouralSettings: 5, fixedSettings: 1, cosmeticOnly: 0, unknownBefore: 1, mismatched: 1,
};
type Job = Parameters<typeof JobTable>[0]["jobs"][number];
// Task-130: references arrive resolved, as the engine readers return them.
const personRef = (id: string, name: string) => ({ kind: "person", id, name, readable: true, email: name.includes("@") ? name : null, system: !name.includes("@") });
const PERSON_IDS: Record<string, string> = { "amara.okafor@contoso.example": "8c1e0000-0000-4000-8000-0000000000a2", "sam.ortiz@contoso.example": "8c1e0000-0000-4000-8000-0000000000b3" };
const refs = (requester: string, extra: Partial<RowReferences> = {}): RowReferences => ({
  ...EMPTY_REFERENCES, people: { requested_by: personRef(requester.includes("@") ? PERSON_IDS[requester] ?? "8c1e0000-0000-4000-8000-0000000000a1" : requester, requester) }, ...extra,
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
  id: "7a1d0f3e-0000-4000-8000-000000000001", name: "Undo low-risk changes", enabled: true, paused_at: null, run_as_repair_required: false,
  run_as_principal_id: "3f9c2b1e-0000-4000-8000-000000000002",
  run_as_principal: { id: "3f9c2b1e-0000-4000-8000-000000000002", email: "svc-policy@contoso.com", name: "Policy service account", readable: true },
  resource_type: null, blast_radius: "cosmetic", natural_key_glob: null, change_type: "modified", action: "auto_remediate",
  max_blast_radius: "cosmetic", max_actions_per_window: 50, window_seconds: 3600, created_by: "marouanedefili@gmail.com", created_at: "2026-09-12T08:00:00Z",
  last_action_at: "2026-10-02T07:40:00Z", last_action_status: "executed", last_action_natural_key: "namedLocation:Branch offices", last_action_job_id: "a3",
  last_action_name: "Branch offices", last_action_resource_type: "namedLocation", actions_last_7_days: 14,
};
const NO_ACTION = { last_action_at: null, last_action_status: null, last_action_natural_key: null, last_action_job_id: null, last_action_name: null, last_action_resource_type: null, actions_last_7_days: 0 };
// Task-92: an undo rule that is off, with its activation preview open.
const OFF_POLICY: Policy = {
  ...POLICY, ...NO_ACTION, id: "7a1d0f3e-0000-4000-8000-000000000004", name: "Undo changes to admin groups", enabled: false, resource_type: "group", blast_radius: null,
  change_type: null, natural_key_glob: "group:Admin*", max_blast_radius: "access-affecting", max_actions_per_window: 5,
};
// The list: a running undo rule, a paused approval rule, an undo rule stopped because its
// account needs repair, the undo rule that is off, and an alert rule.
const PAUSED_POLICY: Policy = {
  ...POLICY, ...NO_ACTION, id: "7a1d0f3e-0000-4000-8000-000000000005", name: "Ask before changing sign-in rules", action: "require_approval",
  resource_type: "conditionalAccessPolicy", blast_radius: null, change_type: null, max_blast_radius: "access-affecting", max_actions_per_window: 10,
  paused_at: "2026-10-02T08:55:00Z", run_as_principal_id: null, run_as_principal: null, actions_last_7_days: 10,
  last_action_at: "2026-10-02T08:55:00Z", last_action_status: "queued", last_action_natural_key: "conditionalAccessPolicy:Block legacy auth", last_action_name: "Block legacy auth", last_action_resource_type: "conditionalAccessPolicy",
};
const STOPPED_POLICY: Policy = {
  ...POLICY, ...NO_ACTION, id: "7a1d0f3e-0000-4000-8000-000000000006", name: "Undo mail flow changes", resource_type: "exchangeTransportRule", blast_radius: null,
  run_as_repair_required: true, run_as_principal_id: "8c1e0000-0000-4000-8000-0000000000b4",
  run_as_principal: { id: "8c1e0000-0000-4000-8000-0000000000b4", email: "lee.chen@contoso.example", name: "Lee Chen", readable: true },
  max_actions_per_window: null, window_seconds: null,
};
const POLICIES: Policy[] = [POLICY, PAUSED_POLICY, STOPPED_POLICY, OFF_POLICY, {
  ...POLICY, ...NO_ACTION, id: "7a1d0f3e-0000-4000-8000-000000000003", name: "Alert on changes that could lock out admins", action: "alert", blast_radius: "tenant-lockout", change_type: null,
  max_blast_radius: "tenant-lockout", max_actions_per_window: null, window_seconds: null, run_as_principal_id: null, run_as_principal: null,
}];
// The running rule's newest actions: one undone, one failed, one waiting.
const POLICY_ACTIONS: PolicyAction[] = [
  { job_id: "r11", status: "queued", queued_at: "2026-10-02T09:30:00Z", finished_at: null, error: null, drift_id: "d9200000-0000-4000-8000-000000000011", natural_key: "group:Sales", resource_type: "group", change_type: "modified", blast_radius: "cosmetic", name: "Sales" },
  { job_id: "a3", status: "executed", queued_at: "2026-10-02T07:38:00Z", finished_at: "2026-10-02T07:40:00Z", error: null, drift_id: "d9200000-0000-4000-8000-000000000012", natural_key: "namedLocation:Branch offices", resource_type: "namedLocation", change_type: "modified", blast_radius: "cosmetic", name: "Branch offices" },
  { job_id: "r12", status: "failed", queued_at: "2026-10-01T09:10:00Z", finished_at: "2026-10-01T09:15:00Z", error: "Graph 403: Authorization_RequestDenied on PATCH /groups/5d1c0000-0000-4000-8000-0000000000f2", drift_id: "d9200000-0000-4000-8000-000000000013", natural_key: "group:Helpdesk admins", resource_type: "group", change_type: "modified", blast_radius: "cosmetic", name: "Helpdesk admins" },
];
const ACTIVATION_PREVIEW: ActivationPreview = {
  id: "9a0c0000-0000-4000-8000-000000000092", requestedBy: "8c1e0000-0000-4000-8000-0000000000a1",
  createdAt: "2026-10-02T09:38:00Z", expiresAt: "2026-10-02T10:08:00Z",
  policy: { id: OFF_POLICY.id, name: OFF_POLICY.name, enabled: false, action: "auto_remediate" },
  matched: [
    { driftId: "d9200000-0000-4000-8000-000000000001", naturalKey: "group:Finance", resourceType: "group", changeType: "modified", blastRadius: "cosmetic", detectedAt: "2026-10-02T08:10:00Z" },
    { driftId: "d9200000-0000-4000-8000-000000000003", naturalKey: "group:Marketing", resourceType: "group", changeType: "modified", blastRadius: "cosmetic", detectedAt: "2026-10-02T08:12:00Z" },
  ],
  matchedOverCeiling: [{ driftId: "d9200000-0000-4000-8000-000000000002", naturalKey: "group:Break-glass admins", resourceType: "group", changeType: "modified", blastRadius: "tenant-lockout", detectedAt: "2026-10-02T08:20:00Z" }],
  operations: [
    { naturalKey: "group:Finance", resourceType: "group", verb: "update", blastRadius: "cosmetic", role: "matched", driftId: "d9200000-0000-4000-8000-000000000001" },
    { naturalKey: "group:Marketing", resourceType: "group", verb: "update", blastRadius: "cosmetic", role: "matched", driftId: "d9200000-0000-4000-8000-000000000003" },
    { naturalKey: "group:Privileged approvers", resourceType: "group", verb: "create-or-update", blastRadius: "tenant-lockout", role: "dependency" },
  ],
  dependencies: [{ naturalKey: "group:Privileged approvers", resourceType: "group", blastRadius: "tenant-lockout", requiredBy: ["group:Finance"], overCeiling: true }],
  impact: { maxBlastRadius: "tenant-lockout", ceiling: "cosmetic" },
  unsupported: [],
  unknowns: [],
  runAs: {
    principalId: OFF_POLICY.run_as_principal_id, email: "svc-policy@contoso.com", name: "svc-policy@contoso.com", readable: true, disabled: false, authorized: true,
    grants: [{ id: "6a000000-0000-4000-8000-000000000092", role: "restorer", scope: "*", activeFrom: "2026-09-01T00:00:00Z", activeUntil: null }],
  },
  ownership: { state: "read", resources: [{ evidenceId: "0e900000-0000-4000-8000-000000000092", naturalKey: "group:Finance", state: "owned", entityCode: "CREOS", expiresAt: "2026-10-03T09:00:00Z" }] },
  benchmarkFindings: { state: "read", findings: [{ id: "e7a10000-0000-4000-8000-0000000000e1", controlId: "keel.groups.owner", title: "Every group has an owner", verdict: "fail", exposed: true, link: "linked", driftIds: ["d9200000-0000-4000-8000-000000000001"] }] },
  limits: { maxBlastRadius: "cosmetic", maxActionsPerWindow: 50, windowSeconds: 3600, automationHalted: false },
  blockers: [], verdict: "ready",
  versions: { policy: "1f".repeat(32), grant: "2e".repeat(32), ownership: "3d".repeat(32), projection: "4c".repeat(32) },
  digest: "5b".repeat(32),
  outcomes: { queued: 1, rolledBack: 0, failed: 0 },
};
// Task-93: approved emergency changes, one in force, one ended and settled, one revoked.
const PERSON_AMARA = { id: "8c1e0000-0000-4000-8000-0000000000a1", email: "amara.okafor@contoso.example", name: "Amara Okafor", readable: true };
const PERSON_ONCALL = { id: "8c1e0000-0000-4000-8000-0000000000a2", email: "oncall@contoso.example", name: "On-call engineer", readable: true };
const INTENT_BASE = {
  resourceType: "conditionalAccessPolicy", transitionDigest: "6d".repeat(32), owner: PERSON_ONCALL, approver: PERSON_AMARA,
  revokedAt: null, revokedBy: null, revokeReason: null, settledAt: null, settlement: null,
} as const;
const INTENTS: ChangeIntent[] = [
  {
    ...INTENT_BASE, id: "c1a70000-0000-4000-8000-000000000093", naturalKey: "conditionalAccessPolicy:Block legacy auth",
    transitions: [{ field: "state", before: { present: true, value: "enabled" }, after: { present: true, value: "enabledForReportingButNotEnforced" } }],
    reason: "INC-4410: a partner app breaks under the block", externalChangeId: "CHG0031337", sourceDriftId: "d9300000-0000-4000-8000-000000000001",
    windowStart: "2026-10-02T09:10:00Z", windowEnd: "2026-10-02T12:40:00Z", approvedAt: "2026-10-02T09:10:00Z", decisionDigest: "9d".repeat(32), state: "active",
  },
  {
    ...INTENT_BASE, id: "c1a70000-0000-4000-8000-000000000094", naturalKey: "group:Finance", resourceType: "group",
    transitions: [{ field: "visibility", before: { present: true, value: "Private" }, after: { present: true, value: "Public" } }],
    reason: "Open the group to responders", externalChangeId: null, sourceDriftId: null,
    windowStart: "2026-10-01T08:00:00Z", windowEnd: "2026-10-01T12:00:00Z", approvedAt: "2026-10-01T08:00:00Z", decisionDigest: "8e".repeat(32), state: "ended",
    settledAt: "2026-10-01T12:05:00Z", settlement: { endedAt: "2026-10-01T12:00:00Z", currentState: "drifted", snapshotId: "5a2be911-0000-4000-8000-000000000093", observedAt: "2026-10-01T11:50:00Z", driftId: "d9300000-0000-4000-8000-000000000002" },
  },
  {
    ...INTENT_BASE, id: "c1a70000-0000-4000-8000-000000000095", naturalKey: "group:Payroll", resourceType: "group",
    transitions: [{ field: "mailNickname", before: { present: true, value: "Payroll" }, after: { present: true, value: "PayrollOps" } }],
    reason: "Mail routing during the migration", externalChangeId: null, sourceDriftId: null,
    windowStart: "2026-09-30T08:00:00Z", windowEnd: "2026-10-01T08:00:00Z", approvedAt: "2026-09-30T08:00:00Z", decisionDigest: "7f".repeat(32), state: "revoked",
    revokedAt: "2026-09-30T10:00:00Z", revokedBy: PERSON_AMARA, revokeReason: "migration finished early",
  },
];
const INTENT_CHANGES: IntentCandidate[] = [{
  driftId: "d9300000-0000-4000-8000-000000000003", naturalKey: "group:Old project team", resourceType: "group", detectedAt: "2026-10-02T08:30:00Z",
  transitions: [
    { field: "visibility", before: { present: true, value: "Private" }, after: { present: true, value: "Public" } },
    { field: "description", before: { present: false, value: null }, after: { present: true, value: "Archived" } },
  ],
}];
const CHANNELS = [
  { id: "c4e10000-0000-4000-8000-0000000000c1", kind: "webhook", config: { url: "https://hooks.contoso.com/keel" }, enabled: true, created_at: "2026-09-01T08:00:00Z" },
  { id: "c4e10000-0000-4000-8000-0000000000c2", kind: "email", config: { to: "secops@contoso.com", from: "keel@contoso.com" }, enabled: true, created_at: "2026-09-01T08:05:00Z" },
  { id: "c4e10000-0000-4000-8000-0000000000c3", kind: "pagerduty", config: { routingKeyRef: "env:KEEL_PAGERDUTY_KEY", region: "eu" }, enabled: true, created_at: "2026-09-02T08:00:00Z" },
  { id: "c4e10000-0000-4000-8000-0000000000c4", kind: "slack", config: { endpointRef: "env:KEEL_SLACK_WEBHOOK" }, enabled: true, created_at: "2026-09-03T08:00:00Z" },
  // Turned off three days ago; its history is kept.
  { id: "c4e10000-0000-4000-8000-0000000000c5", kind: "teams", config: { endpointRef: "env:KEEL_TEAMS_WEBHOOK" }, enabled: false, created_at: "2026-08-20T08:00:00Z" },
];
const SIGN_IN_ALERT = { alertId: "a1e70000-0000-4000-8000-000000000001", resourceKey: "conditionalAccessPolicy:Block legacy auth", control: "baseline", condition: "drift", occurrence: 1 };
const DEVICE_ALERT = { alertId: "a1e70000-0000-4000-8000-000000000002", resourceKey: "deviceConfiguration:Corporate laptops", control: "baseline", condition: "drift", occurrence: 1 };
const DELIVERIES = [
  { id: "d0e10000-0000-4000-8000-0000000000d1", event: { kind: "alert.opened", severity: "critical", ...SIGN_IN_ALERT }, channel_id: CHANNELS[0].id, channel_kind: "webhook", status: "retrying", attempts: 2, last_error: "the webhook did not answer in time", next_attempt_at: "2026-10-02T09:45:00Z", created_at: "2026-10-02T09:38:00Z" },
  { id: "d0e10000-0000-4000-8000-0000000000d2", event: { kind: "alert.opened", severity: "critical", ...SIGN_IN_ALERT }, channel_id: CHANNELS[1].id, channel_kind: "email", status: "delivered", attempts: 1, last_error: null, next_attempt_at: null, created_at: "2026-10-02T09:38:00Z", delivered_at: "2026-10-02T09:38:04Z" },
  { id: "d0e10000-0000-4000-8000-0000000000d3", event: { kind: "alert.opened", severity: "critical", ...SIGN_IN_ALERT }, channel_id: CHANNELS[2].id, channel_kind: "pagerduty", status: "delivered", attempts: 2, last_error: null, next_attempt_at: null, created_at: "2026-10-02T09:38:00Z", delivered_at: "2026-10-02T09:38:40Z", provider_receipt: { channel: "pagerduty", provider: "pagerduty", outcome: "delivered", httpStatus: 202, semantics: "Accepted by PagerDuty. Events with the same dedup key join one incident.", endpointHost: "events.eu.pagerduty.com", dedupKey: "keel:alert:6f1c2a54-1d3b-4c8e-9a51-3e0d7c1b2a90:1" } },
  { id: "d0e10000-0000-4000-8000-0000000000d4", event: { kind: "alert.reopened", severity: "warning", ...DEVICE_ALERT, occurrence: 2 }, channel_id: CHANNELS[3].id, channel_kind: "slack", status: "failed", attempts: 1, last_error: "Slack refused the message (HTTP 404): the webhook was removed or turned off", next_attempt_at: null, created_at: "2026-10-02T09:12:00Z", provider_receipt: { channel: "slack", provider: "slack", outcome: "rejected", httpStatus: 404, endpointHost: "hooks.slack.com", providerStatus: "no_service" } },
  { id: "d0e10000-0000-4000-8000-0000000000d5", event: { kind: "alert.reopened", severity: "warning", ...DEVICE_ALERT, occurrence: 2 }, channel_id: CHANNELS[3].id, channel_kind: "slack", status: "failed", attempts: 1, last_error: "Slack refused the message (HTTP 404): the webhook was removed or turned off", next_attempt_at: null, created_at: "2026-10-02T09:12:30Z", provider_receipt: { channel: "slack", provider: "slack", outcome: "rejected", httpStatus: 404, endpointHost: "hooks.slack.com", providerStatus: "no_service" } },
  { id: "d0e10000-0000-4000-8000-0000000000d6", event: { kind: "test", severity: "notice", requestedBy: "8c1e0000-0000-4000-8000-0000000000a1" }, channel_id: CHANNELS[3].id, channel_kind: "slack", status: "delivered", attempts: 1, last_error: null, next_attempt_at: null, created_at: "2026-10-01T16:02:00Z", delivered_at: "2026-10-01T16:02:01Z" },
  { id: "d0e10000-0000-4000-8000-0000000000d7", event: { kind: "alert.opened", severity: "warning", ...DEVICE_ALERT }, channel_id: CHANNELS[1].id, channel_kind: "email", status: "delivered", attempts: 1, last_error: null, next_attempt_at: null, created_at: "2026-10-02T03:10:00Z", delivered_at: "2026-10-02T03:10:03Z" },
  { id: "d0e10000-0000-4000-8000-0000000000d8", event: { kind: "alert.opened", severity: "warning", ...DEVICE_ALERT }, channel_id: CHANNELS[0].id, channel_kind: "webhook", status: "delivered", attempts: 1, last_error: null, next_attempt_at: null, created_at: "2026-10-02T03:10:00Z", delivered_at: "2026-10-02T03:10:01Z" },
  { id: "d0e10000-0000-4000-8000-0000000000d9", event: { kind: "alert.opened", severity: "notice", resourceKey: "group:Finance", control: "baseline", condition: "drift", alertId: "a1e70000-0000-4000-8000-000000000003", occurrence: 1 }, channel_id: CHANNELS[4].id, channel_kind: "teams", status: "delivered", attempts: 1, last_error: null, next_attempt_at: null, created_at: "2026-09-29T11:00:00Z", delivered_at: "2026-09-29T11:00:02Z" },
];
const SUBSCRIPTIONS = [
  { id: "5b500000-0000-4000-8000-0000000000f1", channel_id: CHANNELS[0].id, event_glob: "*", min_severity: "warning", created_at: "2026-09-01T08:10:00Z" },
  { id: "5b500000-0000-4000-8000-0000000000f2", channel_id: CHANNELS[1].id, event_glob: "alert.opened", min_severity: "critical", created_at: "2026-09-01T08:12:00Z" },
  { id: "5b500000-0000-4000-8000-0000000000f3", channel_id: CHANNELS[3].id, event_glob: "alert.reopened", min_severity: "warning", created_at: "2026-09-03T08:10:00Z" },
];
const ESCALATION_RULES = [
  { id: "e5c10000-0000-4000-8000-0000000000e1", control: null, min_severity: "critical", ack_within_ms: 30 * 60_000, enabled: true, created_at: "2026-09-02T08:30:00Z", owner_principal_id: "8c1e0000-0000-4000-8000-0000000000b3", owner_name: "Sam Ortiz", owner_email: "sam.ortiz@contoso.example", owner_disabled_at: null, escalate_channel_id: CHANNELS[2].id, channel_kind: "pagerduty", channel_enabled: true },
];
const PEOPLE_CHOICES = [
  { id: "8c1e0000-0000-4000-8000-0000000000a1", name: "Marouane Defili", email: "marouanedefili@gmail.com" },
  { id: "8c1e0000-0000-4000-8000-0000000000a2", name: "Amara Okafor", email: "amara.okafor@contoso.example" },
  { id: "8c1e0000-0000-4000-8000-0000000000b3", name: "Sam Ortiz", email: "sam.ortiz@contoso.example" },
];
const DESTINATIONS = [{ id: "de570000-0000-4000-8000-0000000000e1", tenant_ref: "t", name: "Sentinel CEF", kind: "cef", config: { transport: "https", url: "https://siem.contoso.com/cef", acknowledgement: "http-response" }, enabled: true, revoked_at: null, created_by: "marouanedefili@gmail.com", created_at: now }];
const DESTINATION_STATUSES = [{ destinationId: DESTINATIONS[0].id, tenantRef: "t", kind: "cef", paused: false, pending: 14, delivering: 2, acknowledged: 18190, quarantined: 3, oldestPendingObservedAt: now, lagMs: 41000 }] as never[];
// Roadmap task-97: ServiceNow on with one decision update held back, and a second
// tenant whose mapping is missing two settings.
const SERVICENOW_ON: ServiceNowStatus = {
  configured: true, enabled: true, problems: [],
  mapping: {
    instanceHost: "contoso.service-now.com", table: "u_keel_gated_change",
    fields: { state: "u_gate", approver: "u_gate_owner.email", planVersion: "u_plan_rev", planDigest: "u_plan_hash", keelRequest: "u_keel_ref", keelDecision: "u_keel_outcome" },
    approvedValues: ["gate_passed"], rejectedValues: ["gate_blocked", "gate_withdrawn"],
    tokenRef: "env:KEEL_SERVICENOW_TOKEN", callbacks: "signed", callbackSecretRef: "env:KEEL_SERVICENOW_CALLBACK_SECRET",
  },
  mirror: { records: 12, waiting: 2, pendingUpdates: 1, heldBack: 1, conflicts: 0 },
  heldBack: [{ eventId: "keel:decision:5e9c0000-0000-4000-8000-000000000097", kind: "decision", externalRef: "9d3f0000000040008000000000000097", attempts: 1, reason: "rejected by adapter", lastError: "ServiceNow PATCH returned HTTP 403", createdAt: now }],
  updatedAt: now, updatedBy: "marouanedefili@gmail.com",
  docSource: { url: "https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html", retrievedAt: "2026-10-04" },
};
const SERVICENOW_OFF: ServiceNowStatus = {
  ...SERVICENOW_ON, enabled: false,
  problems: [
    { code: "states-rejected", message: "No state value is mapped to rejected." },
    { code: "field-approver", message: "No field is mapped for the person who decided (a field of the table or a dot-walked reference field)." },
  ],
  mapping: { ...SERVICENOW_ON.mapping!, rejectedValues: [], fields: { ...SERVICENOW_ON.mapping!.fields, approver: "" } },
  mirror: { records: 0, waiting: 0, pendingUpdates: 0, heldBack: 0, conflicts: 0 }, heldBack: [],
};
const EVIDENCE = [
  { seq: "18205", occurred_at: "2026-10-02T09:39:02Z", kind: "approval-decision", actor: "amara.okafor@contoso.example", subject: { requestId: "a9e10000-0000-4000-8000-000000000100", action: "restore", decision: "approved", executor: "worker", jobId: "a3" } },
  { seq: "18204", occurred_at: "2026-10-02T09:38:12Z", kind: "approval-decision", actor: "marouanedefili@gmail.com", subject: { requestId: "r0", decision: "approve" } },
  { seq: "18203", occurred_at: "2026-10-02T09:31:00Z", kind: "action-attempt", actor: "marouanedefili@gmail.com", subject: { action: "backup", decision: "attempted" } },
  { seq: "18202", occurred_at: "2026-10-02T09:12:44Z", kind: "collection.completed", actor: "scheduler", subject: { types: 142, items: 4812 } },
  { seq: "18201", occurred_at: "2026-10-02T09:05:10Z", kind: "policy-evaluation", actor: "policy-automation", subject: { naturalKey: "group:5d1c0000-0000-4000-8000-0000000000f1", matched: false } },
  { seq: "18200", occurred_at: "2026-10-02T08:52:30Z", kind: "action-attempt", actor: "sam.ortiz@contoso.example", subject: { action: "restore", decision: "denied", reason: "capability" } },
  { seq: "18190", occurred_at: "2026-10-01T14:05:00Z", kind: "policy-evaluation", actor: "policy-automation", subject: { naturalKey: "group:5d1c0000-0000-4000-8000-0000000000f1", matched: true } },
  { seq: "18171", occurred_at: "2026-09-28T06:10:00Z", kind: "recovery-drill", actor: "scheduler", subject: { mode: "live", outcome: "passed", cleanup: { status: "complete" } } },
  { seq: "18170", occurred_at: "2026-09-28T05:00:00Z", kind: "offsite-copy", actor: "scheduler", subject: { dumpSha256: "4c".repeat(32), remoteSha256: "4c".repeat(32), verification: { ok: true } } },
];
// Activity shows more than the pages that list recent work: two older days of jobs, so
// the Day grouping and the 7-day chart have something to show.
const ACTIVITY_PEOPLE = {
  "marouanedefili@gmail.com": personRef("8c1e0000-0000-4000-8000-0000000000a1", "marouanedefili@gmail.com"),
  "amara.okafor@contoso.example": personRef("8c1e0000-0000-4000-8000-0000000000a2", "amara.okafor@contoso.example"),
  "sam.ortiz@contoso.example": personRef("8c1e0000-0000-4000-8000-0000000000b3", "sam.ortiz@contoso.example"),
  scheduler: personRef("scheduler", "scheduler"),
  "policy-automation": personRef("policy-automation", "policy-automation"),
};
const ACTIVITY_CHANGES: Record<string, ActivityChanges> = {
  y2: {
    basis: "backup", sides: { before: "Previous backup", after: "This backup" },
    about: "Each setting as the backup before this one read it, and as this backup read it.",
    total: 3, compare: { from: "0b5e0000-0000-4000-8000-0000000000c8", to: "0b5e0000-0000-4000-8000-0000000000d5" },
    names: { "b1ea0000-0000-4000-8000-000000000001": "Break-glass admins" },
    changes: [
      { name: "Old project team", resourceType: "group", change: "removed", fieldsTotal: 2, fields: [
        { path: "description", before: "Project Atlas, closed in September", after: null },
        { path: "securityEnabled", before: true, after: null },
      ] },
      { name: "Block legacy auth", resourceType: "conditionalAccessPolicy", change: "changed", fieldsTotal: 2, fields: [
        { path: "state", before: "enabled", after: "enabledForReportingButNotEnforced" },
        { path: "conditions.users.excludeGroups", before: ["b1ea0000-0000-4000-8000-000000000001"], after: ["b1ea0000-0000-4000-8000-000000000001", "f1aa0000-0000-4000-8000-000000000002"] },
      ] },
      { name: "Windows compliance", resourceType: "deviceCompliancePolicy", change: "added", fieldsTotal: 2, fields: [
        { path: "passwordRequired", before: null, after: true },
        { path: "scheduledActionsForRule", before: null, after: [{ ruleName: "PasswordRequired", gracePeriodHours: 24 }] },
      ] },
    ],
  },
  y1: {
    basis: "restore", sides: { before: "Before the restore", after: "Would restore to" },
    about: "Each setting as the last backup before the restore read it, and as the restored backup has it.",
    total: 1, compare: null, names: {},
    changes: [
      { name: "Finance", resourceType: "group", change: "changed", fieldsTotal: 1, fields: [{ path: "securityEnabled", before: false, after: true }] },
    ],
  },
};
const activityJobs = (jobs: Job[]): Job[] => [
  ...jobs,
  job("y1", "restore", "failed", { requestedBy: "amara.okafor@contoso.example", params: { artifactId: "7f3c0000-0000-4000-8000-000000000010", mode: "enforce" }, error: "Graph 400: Exchange Online would not accept 2 of the mailbox rules", createdAt: "2026-10-01T16:50:00Z", startedAt: "2026-10-01T16:50:30Z", finishedAt: "2026-10-01T16:52:00Z", references: refs("amara.okafor@contoso.example", { plan: { ...PLAN_REF, id: "7f3c0000-0000-4000-8000-000000000010", resources: 2, snapshotAt: "2026-10-01T09:12:00Z" } }) }),
  job("y2", "backup", "succeeded", { requestedBy: "scheduler", params: { tier: "tier2" }, createdAt: "2026-10-01T02:00:00Z", startedAt: "2026-10-01T02:00:10Z", finishedAt: "2026-10-01T02:09:00Z" }),
  job("y3", "backup", "succeeded", { requestedBy: "scheduler", params: { tier: "tier1" }, createdAt: "2026-09-30T02:00:00Z", startedAt: "2026-09-30T02:00:10Z", finishedAt: "2026-09-30T02:03:00Z" }),
  job("y4", "collect", "succeeded", { requestedBy: "scheduler", params: {}, createdAt: "2026-09-28T02:00:00Z", startedAt: "2026-09-28T02:00:10Z", finishedAt: "2026-09-28T02:12:00Z" }),
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
  { id: "b1180000-0000-4000-8000-000000000118", label: "Post-migration golden state", description: "After the tenant move", setAt: "2026-09-29T14:02:00Z", setBy: "8c1e0000-0000-4000-8000-0000000000a1", setByRef: { kind: "person", id: "8c1e0000-0000-4000-8000-0000000000a1", name: "Marouane Defili", href: "/principals" }, active: true, resourceCount: 4812,
    version: 1, supersedesId: null, supersededById: null, supersededAt: null, capture: CAPTURED("2026-09-29T13:40:00Z", "0b5e0000-0000-4000-8000-0000000000c8"), changesSinceCapture: COMPARED(1, 2, 0) },
  { id: "b1170000-0000-4000-8000-000000000117", label: "Before migration (v2)", description: null, setAt: "2026-09-01T09:00:00Z", setBy: "scheduler", setByRef: { kind: "person", id: "scheduler", name: "Keel's scheduler", href: null }, active: false, resourceCount: 4590,
    version: 2, supersedesId: "b1160000-0000-4000-8000-000000000116", supersededById: null, supersededAt: null, capture: CAPTURED("2026-09-01T08:30:00Z", "0b5e0000-0000-4000-8000-0000000000a9"), changesSinceCapture: COMPARED(30, 9, 2) },
  { id: "b1160000-0000-4000-8000-000000000116", label: "Before migration", description: null, setAt: "2026-08-20T10:00:00Z", setBy: "scheduler", setByRef: { kind: "person", id: "scheduler", name: "Keel's scheduler", href: null }, active: false, resourceCount: 4502,
    version: 1, supersedesId: null, supersededById: "b1170000-0000-4000-8000-000000000117", supersededAt: "2026-09-01T09:00:00Z", capture: CAPTURED("2026-08-20T09:30:00Z", null, "legacy-resource-versions"), changesSinceCapture: COMPARED(44, 12, 3) },
];
const CAPTURE_SOURCES = [
  { id: "0b5e0000-0000-4000-8000-0000000000d6", startedAt: "2026-10-02T09:00:00Z", completedAt: "2026-10-02T09:12:00Z", resourceCount: 4840 },
  { id: "0b5e0000-0000-4000-8000-0000000000d5", startedAt: "2026-10-01T09:00:00Z", completedAt: "2026-10-01T09:11:00Z", resourceCount: 4838 },
  { id: "0b5e0000-0000-4000-8000-0000000000c8", startedAt: "2026-09-29T13:30:00Z", completedAt: "2026-09-29T13:40:00Z", resourceCount: 4812 },
];

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
const TWO_PERSON_REQUEST = "a9e10000-0000-4000-8000-000000000101";

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
  ct("exchange-mail-flow", "protected", { criticality: "tier1", itemCount: 23, fidelity: { declared: "full", measured: "full", verifiedAt: "2026-09-24T10:00:00Z" } }),
  ct("exchange-mailbox-settings", "protected", { criticality: "tier2", itemCount: 410 }),
  ct("sharepoint-site-settings", "protected", { criticality: "tier2", itemCount: 12 }),
  ct("teams-org-policies", "protected", { criticality: "tier2", itemCount: 9, stale: true, lastCollectedAt: "2026-09-29T02:00:00Z" }),
  ct("purview-retention-dlp", "failed", { criticality: "tier2", outcome: "unavailable", itemCount: null }),
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

// Q45: a restore planned with the command line (no portal job) whose dry run shortens
// group expiry. Its content effects are reviewed and approved on their own page.
const CLI_PLAN_REF = { kind: "dry-run", id: "7f3c0000-0000-4000-8000-000000000045", name: null, readable: true, status: "completed", undo: false, resources: 1, snapshotAt: "2026-10-02T09:12:00Z", dryRunJobId: null, contentEffects: 1 };
const GROUP_EXPIRY_EFFECT: ContentEffect = {
  naturalKey: "groupLifecyclePolicy:default", resourceType: "groupLifecyclePolicy", field: "groupLifetimeInDays", effect: "retention-reducing", before: 400, after: 365,
  disclosure: "Content older than the new retention period can be permanently deleted. KEEL backs up configuration, not content: content deleted or disclosed while this setting is in effect is not recoverable by KEEL, and restoring the previous setting later does not bring it back.",
};
function ContentEffectsReviewHarness() {
  const [approvals, setApprovals] = useState<{ approvedBy: string; approvedAt: string | null }[]>([]);
  return (
    <>
      <Verdict text={approvals.length ? "These content changes are approved. The restore can run once its own request is approved." : "This restore changes kept or shared content. It cannot run until you approve those changes."} tone={approvals.length ? "fine" : "soon"} />
      <a className="text-link back-link" href="#/approvals"><span aria-hidden="true">←</span> All approvals</a>
      <section aria-labelledby="content-effects-plan-heading" className="report-section ce-section">
        <h2 id="content-effects-plan-heading">The restore</h2>
        <p className="ce-plan">Restore of 1 setting, planned 2 Oct 2026, 09:12, asked for by Amara Okafor. Your approval covers exactly the changes below.</p>
        <ContentEffectsPanel approvals={approvals} artifactId={CLI_PLAN_REF.id} canApprove effects={[GROUP_EXPIRY_EFFECT]} effectsDigest="digest-q45"
          onApproved={() => setApprovals([{ approvedBy: "Marouane Defili", approvedAt: now }])} />
        <p className="ce-help">Rejecting happens on the restore request itself. To stop the restore, <a className="ap-inline-link" href="#/approvals">reject the request</a> in Approvals.</p>
      </section>
    </>
  );
}

// Approvals (pick B): three requests wait, one approved restore waits on its content
// changes, and the week's decisions. The restore needs two approvers; Lee Chen signed.
const AMARA = personRef("8c1e0000-0000-4000-8000-0000000000a2", "amara.okafor@contoso.example");
const SAM = { ...personRef("8c1e0000-0000-4000-8000-0000000000b3", "sam.ortiz@contoso.example"), name: "Sam Ortiz" };
const LEE = { ...personRef("8c1e0000-0000-4000-8000-0000000000b4", "lee.chen@contoso.example"), name: "Lee Chen" };
const MAROUANE = { ...personRef("8c1e0000-0000-4000-8000-0000000000a1", "marouanedefili@gmail.com"), name: "Marouane Defili" };
const APPROVAL_BASE = { decidedBy: null, decidedAt: null, reason: null, executor: "worker" as const, requiredApprovals: 1, signoffs: [], preview: null };
const APPROVALS_PENDING: ApprovalRequestRecord[] = [
  { ...APPROVAL_BASE, id: TWO_PERSON_REQUEST, action: "restore", params: { artifactId: PLAN_REF.id }, requestedBy: AMARA.id, justification: "Put the sign-in rules back as they were before Tuesday's incident.", status: "pending", createdAt: "2026-10-02T09:15:00Z", expiresAt: "2026-10-02T12:40:00Z",
    requiredApprovals: 2, signoffs: [LEE],
    preview: { total: 12, services: [{ name: "Entra ID", count: 9 }, { name: "Exchange Online", count: 3 }], more: 9, changes: [
      { name: "Block old sign-in methods", kind: "Sign-in rule", line: null, fields: [{ field: "State", now: "off", after: "on" }], moreFields: 0 },
      { name: "Require a second check for admins", kind: "Sign-in rule", line: null, fields: [{ field: "State", now: "report only", after: "on" }], moreFields: 2 },
      { name: "Head office", kind: "Trusted location", line: null, fields: [{ field: "Ranges", now: "2 ranges", after: "3 ranges" }], moreFields: 0 },
    ] },
    references: { ...EMPTY_REFERENCES, people: { requested_by: AMARA }, plan: PLAN_REF, changes: [{ kind: "change", id: "dr9", name: null, readable: true, naturalKey: "conditionalAccessPolicy:Block legacy auth", changeType: "modified", blastRadius: "access-affecting" }] } },
  { ...APPROVAL_BASE, id: "a9e10000-0000-4000-8000-000000000103", action: "remediate", params: { driftIds: ["dr3", "dr4"] }, requestedBy: SAM.id, justification: "Nobody meant to add the contractors to Finance.", status: "pending", createdAt: "2026-10-02T08:40:00Z", expiresAt: "2026-10-03T05:40:00Z",
    preview: { total: 2, services: [{ name: "Entra ID", count: 2 }], more: 0, changes: [
      { name: "Finance", kind: "Group", line: null, fields: [{ field: "Members", now: "Priya Natarajan, 3 others", after: "Priya Natarajan, 2 others" }, { field: "Description", now: "Finance team and contractors", after: "Finance team" }], moreFields: 0 },
      { name: "Require MFA for admins", kind: "Sign-in rule", line: null, fields: [{ field: "State", now: "report only", after: "on" }], moreFields: 0 },
    ] },
    references: { ...EMPTY_REFERENCES, people: { requested_by: SAM }, changes: [
      { kind: "change", id: "dr3", name: "Finance (group)", readable: true, naturalKey: "group:Finance", changeType: "modified", blastRadius: "access-affecting" },
      { kind: "change", id: "dr4", name: "Require MFA for admins (sign-in rule)", readable: true, naturalKey: "conditionalAccessPolicy:Require MFA for admins", changeType: "modified", blastRadius: "cosmetic" },
    ] } },
  { ...APPROVAL_BASE, id: "a9e10000-0000-4000-8000-000000000102", action: "baseline-activate", params: { baselineId: BASELINES[0].id }, requestedBy: SAM.id, justification: "Post-migration golden state", status: "pending", createdAt: "2026-10-02T06:30:00Z", expiresAt: "2026-10-03T12:00:00Z",
    references: { ...EMPTY_REFERENCES, people: { requested_by: SAM }, baseline: { kind: "baseline", id: BASELINES[0].id, name: "Post-migration golden state", readable: true } } },
];
const APPROVAL_AWAITING_EFFECTS: ApprovalRequestRecord = {
  ...APPROVAL_BASE, id: "a9e10000-0000-4000-8000-000000000104", action: "restore", params: { artifactId: CLI_PLAN_REF.id }, requestedBy: "8c1e0000-0000-4000-8000-0000000000b2", justification: "Put group expiry back to the approved setup", status: "approved", decidedBy: MAROUANE.id, decidedAt: "2026-10-02T07:30:00Z", createdAt: "2026-10-02T07:00:00Z", expiresAt: "2026-10-03T07:00:00Z",
  preview: { total: 1, services: [{ name: "Entra ID", count: 1 }], changes: [{ name: "Group expiry rule", kind: "Group expiry rule", line: "Put back as the backup holds it", fields: [], moreFields: 0 }], more: 0 },
  references: { ...EMPTY_REFERENCES, people: { requested_by: personRef("8c1e0000-0000-4000-8000-0000000000b2", "ops@contoso.com"), decided_by: MAROUANE }, plan: CLI_PLAN_REF },
};
const APPROVAL_HISTORY: ApprovalRequestRecord[] = [
  { ...APPROVAL_BASE, id: "a9e10000-0000-4000-8000-000000000100", action: "remediate", params: { driftIds: ["dr3"] }, requestedBy: "8c1e0000-0000-4000-8000-0000000000b2", justification: null, status: "approved", decidedBy: MAROUANE.id, decidedAt: "2026-10-01T17:02:00Z", createdAt: "2026-10-01T16:40:00Z", expiresAt: "2026-10-02T16:40:00Z",
    references: { ...EMPTY_REFERENCES, people: { requested_by: personRef("8c1e0000-0000-4000-8000-0000000000b2", "ops@contoso.com"), decided_by: MAROUANE }, changes: [{ kind: "change", id: "dr3", name: "Finance (group)", readable: true, naturalKey: "group:Finance", changeType: "modified", blastRadius: "access-affecting" }] } },
  { ...APPROVAL_BASE, id: "a9e10000-0000-4000-8000-000000000098", action: "restore", params: { artifactId: PLAN_REF.id }, requestedBy: AMARA.id, justification: "Undo the change to the guest policy", status: "rejected", decidedBy: SAM.id, decidedAt: "2026-09-30T11:20:00Z", reason: "Outside the change window; ask again on Monday.", createdAt: "2026-09-30T10:05:00Z", expiresAt: "2026-10-01T10:05:00Z",
    references: { ...EMPTY_REFERENCES, people: { requested_by: AMARA, decided_by: SAM }, plan: PLAN_REF } },
  { ...APPROVAL_BASE, id: "a9e10000-0000-4000-8000-000000000097", action: "restore", params: { artifactId: PLAN_REF.id }, requestedBy: SAM.id, justification: "Put the Teams policies back", status: "approved", decidedBy: MAROUANE.id, decidedAt: "2026-09-29T08:10:00Z", createdAt: "2026-09-29T07:00:00Z", expiresAt: "2026-09-30T07:00:00Z", requiredApprovals: 2, signoffs: [LEE, MAROUANE],
    references: { ...EMPTY_REFERENCES, people: { requested_by: SAM, decided_by: MAROUANE }, plan: PLAN_REF } },
  { ...APPROVAL_BASE, id: "a9e10000-0000-4000-8000-000000000096", action: "baseline-activate", params: { baselineId: BASELINES[1].id }, requestedBy: AMARA.id, justification: "Try the stricter setup", status: "expired", createdAt: "2026-09-27T09:00:00Z", expiresAt: "2026-09-28T09:00:00Z",
    references: { ...EMPTY_REFERENCES, people: { requested_by: AMARA }, baseline: { kind: "baseline", id: BASELINES[1].id, name: "Stricter sign-in", readable: true } } },
];

const header = (section: NavSection, title: string, description: string, marker?: string, status?: { tone: "urgent" | "soon" | "low" | "fine"; label: string }) =>
  <PageHeader description={description} generatedAt={now} marker={marker} section={section} status={status} title={title} />;

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
    activeBaseline: { id: "b-118", label: "Post-migration golden state", setAt: "2026-09-29T14:02:00Z", setBy: "8c1e0000-0000-4000-8000-0000000000a1", setByRef: { kind: "person", id: "8c1e0000-0000-4000-8000-0000000000a1", name: "Marouane Defili", href: "/principals" }, resourceCount: 4812 } as never,
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
// Task-76 production host: both apps already exist and were observed; read setup ran
// to completion; the restorer's consent is satisfied and its extra grant is reported.
const SETUP_CHECKED_RUN = "5e7a" + "0c".repeat(30);
const RESTORE_SCOPES = ["Group.ReadWrite.All", "Policy.ReadWrite.ConditionalAccess", "RoleManagement.ReadWrite.Directory"];
const SETUP_CHECKED: SetupState = {
  generatedAt: now,
  canCheck: true,
  canProvision: true,
  checkFailed: false,
  collect: { allowed: true, basis: "read-access-confirmed", missing: [] },
  firstCollection: null,
  scopes: [
    {
      scope: "read", workloads: ["entra-collect", "intune-collect"], observed: true,
      run: { artifactId: SETUP_CHECKED_RUN, state: "complete", workloads: ["entra-collect"], approvedBy: "8c1e0000-0000-4000-8000-0000000000a1", approvedByName: "Marouane", approvedAt: "2026-10-04T07:40:00Z", lastEventAt: "2026-10-04T07:40:09Z", resumableByViewer: true, build: "keel-2026.10.04", qualificationMode: "live-qualified" },
      steps: [
        { ...setupStep("step-3a2b3c4d5e6f7a80", "registration", "collector", "keel-collector", "reuse-existing", "done", null, READ_SCOPES.slice(1)), missingScopes: [] },
        { ...setupStep("step-3a2b3c4d5e6f7a81", "graph-permission", "collector", "keel-collector admin consent", "grant-consent", "done", null, READ_SCOPES.slice(1)), missingScopes: [] },
        setupStep("step-3a2b3c4d5e6f7a83", "keel-app-permission", "collector", "keel.collect", "configure-keel-permission", "done"),
      ],
    },
    {
      scope: "restore", workloads: ["entra-restore"], observed: true, run: null, planId: "plan-8e7d6c5b4a392110",
      steps: [
        { ...setupStep("step-4a2b3c4d5e6f7a80", "registration", "restorer", "keel-restorer", "reuse-existing", "done", null, RESTORE_SCOPES), missingScopes: [] },
        { ...setupStep("step-4a2b3c4d5e6f7a81", "graph-permission", "restorer", "keel-restorer admin consent", "grant-consent", "done", null, RESTORE_SCOPES), missingScopes: [], excessScopes: ["MailboxSettings.ReadWrite"] },
        setupStep("step-4a2b3c4d5e6f7a82", "pim-activation", "restorer", "Privileged Role Administrator", "pim-activate", "waiting-for-you", "entra-restore"),
        setupStep("step-4a2b3c4d5e6f7a83", "keel-app-permission", "restorer", "keel.restore", "configure-keel-permission", "done"),
      ],
    },
  ],
};
const setupCheckedVerdict = setupVerdict(SETUP_CHECKED);

// Task-83: an overdue, escalated alert; an acknowledged one; a resolved one.
const alertEntry = (id: string, occurrence: number, fromState: AlertItem["state"] | null, toState: AlertItem["state"], reason: string, at: string, actorName: string | null = null) =>
  ({ id, occurrence, fromState, toState, reason, actor: actorName ? "8c1e0000-0000-4000-8000-0000000000a1" : "condition:drift-detect", actorName, at, eventId: null });
const INBOX_ALERTS: AlertItem[] = [
  {
    id: "a1e70000-0000-4000-8000-000000000001", resourceKey: "conditionalAccessPolicy:Block legacy auth", name: "Block legacy auth", control: "baseline", condition: "drift",
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
    id: "a1e70000-0000-4000-8000-000000000002", resourceKey: "group:Finance", name: "Finance", control: "baseline", condition: "drift",
    state: "open", conditionActive: true, severity: "warning", occurrence: 1, firstOpenedAt: "2026-10-02T09:30:00Z",
    occurrenceStartedAt: "2026-10-02T09:30:00Z", lastFiringAt: "2026-10-02T09:30:00Z", ackDeadlineAt: null,
    acknowledgedAt: null, acknowledgedByName: null, owner: null, escalated: false, escalationError: null,
    cause: { changeType: "removed", resourceType: "group", snapshotId: "5a9f0000-0000-4000-8000-000000000032" },
    lastEventId: "drift:5a9f0000-0000-4000-8000-000000000032:group:Finance",
    history: [alertEntry("6", 1, null, "open", "condition-firing", "2026-10-02T09:30:00Z")],
  },
  {
    id: "a1e70000-0000-4000-8000-000000000003", resourceKey: "group:Break-glass admins", name: "Break-glass admins", control: "baseline", condition: "drift",
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


// Task-73: measured recovery point and recovery time. A newer off-site copy lacks a
// good group backup, so the older copy still sets the point; a failed restore is
// listed but is not a recovery time sample. RESILIENCE_EMPTY is a tenant with nothing
// measured yet.
const RESILIENCE: ResilienceData = {
  generatedAt: now,
  metrics: {
    version: 1, tenantRef: "sha256:5e7a0b0b0b0b0b0b", generatedAt: now,
    freshness: {
      state: "measured", achievedRpoMs: 13_200_000, required: 54, gaps: [],
      oldestDependency: { key: "type:conditionalAccessPolicy", kind: "type", type: "conditionalAccessPolicy", parentType: null, family: null, ageMs: 13_200_000, since: "2026-10-02T06:00:00.000Z" },
      latestFailures: [{ key: "type:authenticationMethodsPolicy", kind: "type", type: "authenticationMethodsPolicy", parentType: null, family: null, failedAt: "2026-10-02T09:00:00.000Z", outcome: "failed", lastSuccessAt: "2026-10-02T06:00:00.000Z" }],
    },
    recoverablePoint: {
      state: "measured", point: "2026-10-01T04:00:00.000Z", ageMs: 106_800_000,
      fromCopy: { seq: "18190", recordedAt: "2026-10-01T05:12:00.000Z", shippedAt: "2026-10-01T05:10:00.000Z", dumpSha256: "c1".repeat(32), manifestGeneratedAt: "2026-10-01T05:00:00.000Z", counts: true, reason: "verified-offsite-copy", point: "2026-10-01T04:00:00.000Z", missing: [] },
      latestCopy: null,
      copies: [
        { seq: "18190", recordedAt: "2026-10-01T05:12:00.000Z", shippedAt: "2026-10-01T05:10:00.000Z", dumpSha256: "c1".repeat(32), manifestGeneratedAt: "2026-10-01T05:00:00.000Z", counts: true, reason: "verified-offsite-copy", point: "2026-10-01T04:00:00.000Z", missing: [] },
        { seq: "18201", recordedAt: "2026-10-02T05:12:00.000Z", shippedAt: "2026-10-02T05:10:00.000Z", dumpSha256: "e3".repeat(32), manifestGeneratedAt: "2026-10-02T05:00:00.000Z", counts: false, reason: "missing-required-observation", point: null, missing: ["type:group", "relationship:group/members"] },
      ],
    },
    recoveryTime: {
      state: "measured", samples: 2, latestMs: 1_200_000, latestAt: "2026-09-30T14:20:00.000Z", worstMs: 1_200_000, medianMs: 840_000,
      lastAttempt: { source: "restore", ref: "b7c10000-0000-4000-8000-000000000074", at: "2026-10-01T11:00:00.000Z", counts: false, reason: "restore-failed", elapsedMs: null, outcome: "failed" },
      attempts: [
        { source: "drill", ref: "18150", at: "2026-09-28T10:08:00.000Z", counts: true, reason: "live-bounded-drill", elapsedMs: 480_000, outcome: "passed" },
        { source: "restore", ref: "b7c10000-0000-4000-8000-000000000073", at: "2026-09-30T14:20:00.000Z", counts: true, reason: "verified-restore", elapsedMs: 1_200_000, outcome: "succeeded" },
        { source: "restore", ref: "b7c10000-0000-4000-8000-000000000074", at: "2026-10-01T11:00:00.000Z", counts: false, reason: "restore-failed", elapsedMs: null, outcome: "failed" },
      ],
    },
    readiness: {
      state: "drilled", countedDrills: 1, notCounted: [], cleanupFailures: [],
      lastCountedDrill: { at: "2026-09-28T10:08:00.000Z", elapsedMs: 480_000, objects: ["group:keel-rehearsal-20260928T100000Z"] },
      scope: "bounded same-tenant drills of disposable objects; not a tenant-wide recovery proof",
    },
    configured: {
      cadence: [
        { id: "5c4e0000-0000-4000-8000-000000000001", jobKind: "collect", tier: "tier1", cadence: { every: "hour", n: 1, atTime: null }, cron: null, enabled: true },
        { id: "5c4e0000-0000-4000-8000-000000000005", jobKind: "offsite", tier: null, cadence: { every: "day", n: 1, atTime: "05:00" }, cron: null, enabled: true },
      ],
      objectives: null,
    },
  },
  incidents: [{ incident: { id: "1c1d0000-0000-4000-8000-000000000071", title: "Admin consent phishing", status: "open", openedAt: "2026-10-01T08:10:00Z" }, recommended: { snapshotId: "5a2be911-0000-4000-8000-000000000002", collectedAt: "2026-09-30T05:55:00Z" }, pins: 1 }],
  storage: { configured: true, provider: "local-disk", region: "on-prem datacenter A", boundary: null, immutability: "unsupported", generatedAt: "2026-10-01T05:00:00Z", certifies: null, source: "/opt/backups/keel-recovery-manifest.json" },
};
const RESILIENCE_EMPTY: ResilienceData = {
  ...RESILIENCE,
  metrics: {
    ...RESILIENCE.metrics,
    freshness: { state: "unmeasured", achievedRpoMs: null, required: 2, oldestDependency: null, latestFailures: [], gaps: [
      { key: "type:conditionalAccessPolicy", kind: "type", type: "conditionalAccessPolicy", parentType: null, family: null, lastAttempt: null },
      { key: "type:group", kind: "type", type: "group", parentType: null, family: null, lastAttempt: { at: "2026-10-02T09:00:00.000Z", outcome: "failed" } },
    ] },
    recoverablePoint: { state: "unmeasured", point: null, ageMs: null, fromCopy: null, latestCopy: null, copies: [] },
    recoveryTime: { state: "unmeasured", samples: 0, latestMs: null, latestAt: null, worstMs: null, medianMs: null, lastAttempt: null, attempts: [] },
    readiness: { ...RESILIENCE.metrics.readiness, state: "unmeasured", countedDrills: 0, lastCountedDrill: null },
  },
  incidents: [],
  storage: { configured: false, provider: null, region: null, boundary: null, immutability: "unknown", generatedAt: null, certifies: null, source: null },
};

// Task-94: emergency access. bg1 passes every check; bg2 is reached by a policy that
// is switched on, has no recorded method and is overdue for its test, and it was used
// an hour ago with two changes after the sign-in. READINESS_READY is the same tenant
// once bg2 is fixed and the alert was reviewed.
const BG1 = "b9000000-0000-4000-8000-000000000001";
const BG2 = "b9000000-0000-4000-8000-000000000002";
const pass = (reason: string, evidence: Dimension["evidence"] = {}): Dimension => ({ status: "pass", reason, evidence });
const bgPolicies = (bg2Reached: boolean) => [
  { policy: "conditionalAccessPolicy:Require MFA for all", treatment: "excluded" as const, reason: "excluded-directly" },
  { policy: "conditionalAccessPolicy:Block legacy auth", treatment: bg2Reached ? "applies" as const : "excluded" as const, reason: bg2Reached ? "included" : "excluded-directly" },
  { policy: "conditionalAccessPolicy:Report only risk", treatment: "report-only" as const, reason: "not-enforced" },
];
const BG1_ACCOUNT: ReadinessAccount = {
  accountId: BG1, label: "bg1@contoso.onmicrosoft.com", resourceKey: "user:bg1@contoso.onmicrosoft.com",
  validationIntervalDays: 90, rotationIntervalDays: 180, registeredAt: "2026-06-01T08:00:00Z",
  lastValidatedAt: "2026-09-12T10:00:00Z", lastRotatedAt: "2026-08-01T10:00:00Z",
  methodEvidence: { basis: "observed", occurredAt: "2026-10-01T09:00:00Z", methods: ["fido2", "password"] },
  overall: "ready",
  dimensions: {
    cloudOnlyIdentity: pass("cloud-only-member-account", { naturalKey: "user:bg1@contoso.onmicrosoft.com", domain: "contoso.onmicrosoft.com" }),
    phishingResistantCredential: pass("phishing-resistant-method", { basis: "observed", recordedAt: "2026-10-01T09:00:00Z", methods: ["fido2", "password"] }),
    policyExclusions: pass("excluded-from-every-enforced-policy", { policies: bgPolicies(false) }),
    privilegedAccessPath: pass("active-global-administrator", { assignment: `roleAssignment:GlobalAdministrator@${BG1}@/` }),
    lastValidation: pass("validated-recently", { lastValidatedAt: "2026-09-12T10:00:00Z", dueAt: "2026-12-11T10:00:00Z", intervalDays: 90 }),
  },
  reminders: [
    { kind: "validation", intervalDays: 90, last: "2026-09-12T10:00:00Z", dueAt: "2026-12-11T10:00:00Z", status: "scheduled" },
    { kind: "rotation", intervalDays: 180, last: "2026-08-01T10:00:00Z", dueAt: "2027-01-28T10:00:00Z", status: "scheduled" },
  ],
};
const BG2_ACCOUNT: ReadinessAccount = {
  ...BG1_ACCOUNT, accountId: BG2, label: "bg2@contoso.onmicrosoft.com", resourceKey: "user:bg2@contoso.onmicrosoft.com",
  rotationIntervalDays: null, lastValidatedAt: "2026-06-20T10:00:00Z", lastRotatedAt: null, methodEvidence: null, overall: "not-ready",
  dimensions: {
    ...BG1_ACCOUNT.dimensions,
    phishingResistantCredential: { status: "unknown", reason: "no-method-evidence", evidence: {} },
    policyExclusions: { status: "fail", reason: "enforced-policy-applies", evidence: { policies: bgPolicies(true) } },
    privilegedAccessPath: pass("active-global-administrator", { assignment: `roleAssignment:GlobalAdministrator@${BG2}@/` }),
    lastValidation: { status: "due", reason: "validation-overdue", evidence: { lastValidatedAt: "2026-06-20T10:00:00Z", dueSince: "2026-09-18T10:00:00Z", intervalDays: 90 } },
  },
  reminders: [{ kind: "validation", intervalDays: 90, last: "2026-06-20T10:00:00Z", dueAt: "2026-09-18T10:00:00Z", status: "due" }],
};
const READINESS_SURFACES: ReadinessData["surfaces"] = [
  { surface: "conditionalAccess", status: "evaluated", reason: "collected" },
  { surface: "conditionalAccessRiskConditions", status: "evaluated", reason: "evaluated-as-conditional-access", policies: 1 },
  { surface: "authenticationMethodsPolicy", status: "evaluated", reason: "collected" },
  { surface: "roleEligibility", status: "evaluated", reason: "collected" },
  { surface: "roleActivationRules", status: "unsupported", reason: "activation-rules-not-collected" },
  { surface: "identityProtectionRiskPolicies", status: "unsupported", reason: "legacy-risk-policies-not-collected" },
  { surface: "securityDefaults", status: "unsupported", reason: "security-defaults-not-collected" },
  { surface: "applicationAccessRestrictions", status: "unsupported", reason: "application-restrictions-not-collected" },
];
const READINESS: ReadinessData = {
  generatedAt: now, configured: true, overall: "not-ready", reason: "account-not-ready",
  accounts: [BG1_ACCOUNT, BG2_ACCOUNT],
  surfaces: READINESS_SURFACES,
  inventory: { user: { status: "covered", observedAt: "2026-10-02T08:00:00Z" }, conditionalAccessPolicy: { status: "covered", observedAt: "2026-10-02T08:00:00Z" } },
  canary: { status: "watching", reason: "covered", sources: { "sign-in": { status: "covered", readUntil: "2026-10-02T09:30:00Z" }, audit: { status: "covered", readUntil: "2026-10-02T09:30:00Z" } } },
  alerts: [{
    id: "a1e70000-0000-4000-8000-000000000094", resourceKey: "user:bg2@contoso.onmicrosoft.com", condition: "emergency-account-used",
    state: "open", severity: "critical", active: true, occurrence: 1, firstOpenedAt: "2026-10-02T08:40:00Z", lastFiringAt: "2026-10-02T08:40:00Z",
    ackDeadlineAt: "2026-10-02T08:55:00Z", lastEventId: "breakglass-sign-in:si-7f21",
    detail: {
      accountId: BG2, label: "bg2@contoso.onmicrosoft.com", auditEventId: "si-7f21", correlationId: `breakglass:${BG2}:si-7f21`, expectedTest: false, changeCount: 2,
      changes: [
        { auditEventId: "au-9c10", occurredAt: "2026-10-02T08:45:00Z", targetType: "conditionalAccessPolicy", targetId: "c9000000-0000-4000-8000-0000000000c1", operation: "update", activity: "Update conditional access policy" },
        { auditEventId: "au-9c11", occurredAt: "2026-10-02T08:47:00Z", targetType: "group", targetId: "c9000000-0000-4000-8000-0000000000c2", operation: "update", activity: "Add member to group" },
      ],
    },
  }],
};
const READINESS_READY: ReadinessData = {
  ...READINESS, overall: "ready", reason: "every-account-ready",
  accounts: [BG1_ACCOUNT, { ...BG1_ACCOUNT, accountId: BG2, label: "bg2@contoso.onmicrosoft.com", resourceKey: "user:bg2@contoso.onmicrosoft.com" }],
  alerts: [{ ...READINESS.alerts[0], state: "resolved", active: false }],
};

function readinessPage(data: ReadinessData) {
  const verdict = readinessVerdict(data);
  return <>{header("Restore", "Emergency access", "Whether the emergency accounts would let an administrator in when everything else fails, and whether anyone has used them.")}
    <Verdict headline={verdict.headline} text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation"><ReadinessView data={data} /></div></>;
}

function resiliencePage(data: ResilienceData) {
  const verdict = resilienceVerdict(data.metrics, data.generatedAt);
  return <>{header("Restore", "Resilience", "How recent a recovery KEEL could make if this server were lost, and how long a recovery has taken.")}
    <Verdict headline={verdict.headline} text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation"><ResilienceView data={data} /></div></>;
}

// Roadmap task-100: the value report. VALUE_REPORT has a retried restore that was put
// back and checked, a change that came back after being undone, one waiting and one
// failed request, control findings with a reopened one, measured recovery and a
// configured estimate with its assumptions. VALUE_REPORT_SCOPED is an entity-scoped
// reader with no estimate: no hours, and the tenant-wide sections withheld.
const VALUE_SUMMARY = (verified: number, reopened: number, unconfirmed: number, queued: number, failed: number, attempts: number) => {
  const total = verified + reopened + unconfirmed + queued + failed;
  return { total, states: { verified, reopened, unconfirmed, queued, failed }, attempts, retries: attempts - total, percentVerified: total ? Math.round((verified / total) * 1000) / 10 : null };
};
const VALUE_REPORT: ValueReport = {
  version: 1,
  tenantRef: "sha256:5e7a0b0b0b0b0b0b",
  generatedAt: now,
  period: { from: "2026-09-02T09:40:00.000Z", to: "2026-10-02T09:40:00.000Z", days: 30 },
  scope: { central: true, entities: [] },
  outcomes: {
    ...VALUE_SUMMARY(1, 1, 1, 1, 1, 7),
    byFamily: { restore: VALUE_SUMMARY(1, 0, 1, 0, 1, 4), remediation: VALUE_SUMMARY(0, 1, 0, 1, 0, 3) },
    rows: [
      { id: "restore-plan:7f3c0000-0000-4000-8000-000000000100", family: "restore", state: "verified", reason: "journal-and-completion-verified", attempts: 2, retries: 1, firstRequestedAt: "2026-09-20T10:00:00.000Z", lastEventAt: "2026-09-20T11:30:00.000Z", verifiedAt: "2026-09-20T11:30:00.000Z", reopenedAt: null, resources: 3, resourceType: null, changeType: null, planId: "7f3c0000-0000-4000-8000-000000000100", driftId: null, attemptEventIds: ["job:a1000000-0000-4000-8000-000000000001", "job:a1000000-0000-4000-8000-000000000002"] },
      { id: "change:d1f70000-0000-4000-8000-000000000101", family: "remediation", state: "reopened", reason: "changed-again", attempts: 2, retries: 1, firstRequestedAt: "2026-09-15T00:00:00.000Z", lastEventAt: "2026-09-28T00:00:00.000Z", verifiedAt: null, reopenedAt: "2026-09-28T00:00:00.000Z", resources: 1, resourceType: "conditionalAccessPolicy", changeType: "modified", planId: null, driftId: "d1f70000-0000-4000-8000-000000000101", attemptEventIds: ["job:a1000000-0000-4000-8000-000000000003", "job:a1000000-0000-4000-8000-000000000004"] },
      { id: "restore-plan:7f3c0000-0000-4000-8000-000000000102", family: "restore", state: "unconfirmed", reason: "completion-pending", attempts: 1, retries: 0, firstRequestedAt: "2026-09-30T08:00:00.000Z", lastEventAt: "2026-09-30T08:05:00.000Z", verifiedAt: null, reopenedAt: null, resources: 1, resourceType: null, changeType: null, planId: "7f3c0000-0000-4000-8000-000000000102", driftId: null, attemptEventIds: ["job:a1000000-0000-4000-8000-000000000005"] },
      { id: "change:d1f70000-0000-4000-8000-000000000103", family: "remediation", state: "queued", reason: "attempt-pending", attempts: 1, retries: 0, firstRequestedAt: "2026-10-02T09:00:00.000Z", lastEventAt: "2026-10-02T09:00:00.000Z", verifiedAt: null, reopenedAt: null, resources: 1, resourceType: "group", changeType: "added", planId: null, driftId: "d1f70000-0000-4000-8000-000000000103", attemptEventIds: ["job:a1000000-0000-4000-8000-000000000006"] },
      { id: "restore-plan:7f3c0000-0000-4000-8000-000000000104", family: "restore", state: "failed", reason: "all-attempts-failed", attempts: 1, retries: 0, firstRequestedAt: "2026-09-10T12:00:00.000Z", lastEventAt: "2026-09-10T12:01:00.000Z", verifiedAt: null, reopenedAt: null, resources: 2, resourceType: null, changeType: null, planId: "7f3c0000-0000-4000-8000-000000000104", driftId: null, attemptEventIds: ["job:a1000000-0000-4000-8000-000000000007"] },
    ],
    rowsShown: 5,
    undoRunsExcluded: 1,
  },
  findings: {
    withheld: false, total: 3, states: { resolved: 1, open: 1, unchecked: 1 }, reopened: 1, percentResolved: 33.3, rowsShown: 3,
    rows: [
      { id: "finding:keel-custom|1.0.0|default|keel.mfa.admins|1", controlId: "keel.mfa.admins", framework: "keel-custom", edition: "1.0.0", profile: "default", state: "open", reopened: true, resolvedAt: null, resolvedBy: null, failedAt: "2026-09-25T00:00:00.000Z", lastEvaluatedAt: "2026-09-25T00:00:00.000Z", lastVerdict: "fail", lastEvaluationId: "e7a10000-0000-4000-8000-000000000201" },
      { id: "finding:keel-custom|1.0.0|default|keel.guests.invite|1", controlId: "keel.guests.invite", framework: "keel-custom", edition: "1.0.0", profile: "default", state: "unchecked", reopened: false, resolvedAt: null, resolvedBy: null, failedAt: "2026-09-05T00:00:00.000Z", lastEvaluatedAt: "2026-09-15T00:00:00.000Z", lastVerdict: "unknown", lastEvaluationId: "e7a10000-0000-4000-8000-000000000202" },
      { id: "finding:keel-custom|1.0.0|default|keel.groups.owner|1", controlId: "keel.groups.owner", framework: "keel-custom", edition: "1.0.0", profile: "default", state: "resolved", reopened: false, resolvedAt: "2026-09-12T00:00:00.000Z", resolvedBy: { evaluationId: "e7a10000-0000-4000-8000-000000000203", evidenceSeq: "18190" }, failedAt: "2026-09-05T00:00:00.000Z", lastEvaluatedAt: "2026-09-19T00:00:00.000Z", lastVerdict: "pass", lastEvaluationId: "e7a10000-0000-4000-8000-000000000204" },
    ],
  },
  recovery: {
    withheld: false,
    recoveryTime: { state: "measured", samples: 2, medianMs: 14 * 60_000, worstMs: 20 * 60_000, notCounted: 1, drills: 1, restores: 1 },
    freshness: { state: "measured", achievedRpoMs: 5 * 3_600_000, gaps: 0, asOf: now },
    recoverablePoint: { state: "unmeasured", ageMs: null, asOf: now },
  },
  estimate: { state: "configured", source: "/etc/keel/value-estimate.json" },
  hoursSaved: {
    hours: 2, basis: "verified-outcomes-only", owner: "the IT lead", setAt: "2026-09-01T00:00:00.000Z", notEstimated: ["remediation"],
    byFamily: [{ family: "restore", verified: 1, minutesEach: 90, hours: 1.5 }, { family: "finding", verified: 1, minutesEach: 30, hours: 0.5 }],
    assumptions: ["A manual restore of one group and its members takes about 90 minutes.", "Fixing one failing control by hand takes about 30 minutes."],
  },
  complianceClaim: null,
  provenance: {
    reportVersion: 1,
    countingRules: ["One outcome per restore plan or detected change; further jobs for it are retries."],
    sources: { restoreJobsRead: 4, remediateJobsRead: 3, collectionsChecked: 6, evaluationsRead: 9 },
    complete: true,
    evidenceHead: { seq: "18201", hash: "9b".repeat(32), records: "18201" },
    digest: "4c".repeat(32),
  },
};
const VALUE_REPORT_SCOPED: ValueReport = {
  ...VALUE_REPORT,
  scope: { central: false, entities: ["FIN"] },
  outcomes: { ...VALUE_REPORT.outcomes, ...VALUE_SUMMARY(1, 0, 0, 0, 0, 2), byFamily: { restore: VALUE_SUMMARY(1, 0, 0, 0, 0, 2), remediation: VALUE_SUMMARY(0, 0, 0, 0, 0, 0) }, rows: [VALUE_REPORT.outcomes.rows[0]], rowsShown: 1, undoRunsExcluded: null },
  findings: { withheld: true },
  recovery: { withheld: true },
  estimate: { state: "not-configured", source: null, problems: [] },
  hoursSaved: null,
};

function reportsPage(report: ValueReport) {
  const verdict = valueVerdict(report);
  return <>{header("Reports", "Value report", "What KEEL put back and checked, which failing controls were fixed, and how long recovery took, for a period you choose.")}
    <Verdict headline={verdict.headline} text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation"><ValueReportView data={{ report, period: "30d", entity: null }} /></div></>;
}

// Task-99: bounded, grounded answers. A partial answer (part of the week not compared
// yet), a failed-jobs answer, and an answer KEEL cannot give because it has no history.
const ASK_BASE: Omit<GroundedAnswer, "status" | "intent" | "plan" | "records" | "total" | "shown" | "sentence"> = {
  version: 1, understood: null, scope: { central: false, entities: ["SALES"] },
  window: { from: "2026-09-28T00:00:00.000Z", to: now }, known: { from: "2026-09-18T00:00:00.000Z", to: "2026-10-02T06:00:00.000Z" },
  gaps: [{ from: "2026-10-02T06:00:00.000Z", to: now, reason: "not-compared-yet" }], truncated: false, readBy: "rules", generatedAt: now,
};
const ASK_PLAN = { intent: "changes" as const, params: { entity: "SALES", from: "2026-09-28T00:00:00.000Z", to: now, resourceType: null, changeType: null, limit: 25 } };
const ASK_ANSWERED: AskData = { generatedAt: now, entities: ["SALES"], scope: { central: false, entities: ["SALES"] }, answer: {
  ...ASK_BASE, status: "partial", intent: "changes", plan: ASK_PLAN, question: "What changed for Sales this week?", total: 2, shown: 2,
  sentence: "2 matching changes found.",
  records: [
    { kind: "change", id: "a5c00000-0000-4000-8000-000000000991", resourceType: "group", naturalKey: "group:Sales Admins", name: "Sales Admins", changeType: "modified", impact: "access-affecting", decision: null,
      seenAt: "2026-10-01T06:00:00.000Z", window: { from: "2026-09-30T06:00:00.000Z", to: "2026-10-01T06:00:00.000Z" },
      source: { kind: "change", id: "a5c00000-0000-4000-8000-000000000991", href: "/drift", collectionId: "c0110000-0000-4000-8000-000000000992" } },
    { kind: "change", id: "a5c00000-0000-4000-8000-000000000993", resourceType: "conditionalAccessPolicy", naturalKey: "conditionalAccessPolicy:Sales VPN", name: null, changeType: "added", impact: "tenant-lockout", decision: "accept",
      seenAt: "2026-09-29T06:00:00.000Z", window: { from: null, to: "2026-09-29T06:00:00.000Z" },
      source: { kind: "change", id: "a5c00000-0000-4000-8000-000000000993", href: "/drift", collectionId: "c0110000-0000-4000-8000-000000000994" } },
  ],
} };
const ASK_UNKNOWN: AskData = { generatedAt: now, entities: ["FINANCE", "SALES"], scope: { central: true, entities: [] }, answer: {
  ...ASK_BASE, scope: { central: true, entities: [] }, status: "unknown", intent: "changes", question: "What changed between 2020-01-01 and 2020-01-20?",
  plan: { intent: "changes", params: { entity: null, from: "2020-01-01T00:00:00.000Z", to: "2020-01-20T00:00:00.000Z", resourceType: null, changeType: null, limit: 25 } },
  window: { from: "2020-01-01T00:00:00.000Z", to: "2020-01-20T00:00:00.000Z" }, known: null,
  gaps: [{ from: "2020-01-01T00:00:00.000Z", to: "2020-01-20T00:00:00.000Z", reason: "no-history" }], total: 0, shown: 0, records: [],
  sentence: "Not known.",
} };

function askPage(data: AskData) {
  const verdict = askVerdict(data.answer);
  return <>{header("Reports", "Ask", "Ask about changes, backup coverage or failed jobs. Every answer comes from KEEL's own records and names them.")}
    <Verdict text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation"><AskView data={data} question={data.answer?.question ?? ""} /></div></>;
}

// Wave 2 CMP: two snapshots of this tenant, and this tenant against another.
const CMP_SNAP_OLD = "c0a10000-0000-4000-8000-000000000001";
const CMP_SNAP_NEW = "c0a10000-0000-4000-8000-000000000002";
const CMP_SNAP_OTHER = "c0a10000-0000-4000-8000-000000000003";
const COMPARE_TENANTS: CompareTenant[] = [
  { tenantRef: "sha256:5a1e00000000c0a1", label: "This tenant", own: true, snapshots: [
    { id: CMP_SNAP_NEW, completedAt: "2026-10-02T09:12:00Z", resourceCount: 4812 },
    { id: CMP_SNAP_OLD, completedAt: "2026-10-01T09:10:00Z", resourceCount: 4809 },
    { id: "c0a10000-0000-4000-8000-000000000005", completedAt: "2026-09-29T13:40:00Z", resourceCount: 4812 },
    { id: "c0a10000-0000-4000-8000-000000000004", completedAt: "2026-09-25T09:10:00Z", resourceCount: 4790 },
  ] },
  { tenantRef: "sha256:5a1e00000000c0b2", label: "Other tenant 1", own: false, snapshots: [{ id: CMP_SNAP_OTHER, completedAt: "2026-10-02T06:00:00Z", resourceCount: 3120 }] },
];
const COMPARE_SNAPSHOTS: CompareResult = {
  version: 1, mode: "snapshots", portable: false, generatedAt: now,
  left: { kind: "snapshot", tenantRef: "sha256:5a1e00000000c0a1", snapshotId: CMP_SNAP_OLD, at: "2026-10-01T09:10:00Z" },
  right: { kind: "snapshot", tenantRef: "sha256:5a1e00000000c0a1", snapshotId: CMP_SNAP_NEW, at: "2026-10-02T09:12:00Z" },
  settings: {
    totals: { added: 1, removed: 1, changed: 2, unchanged: 4806, notCompared: 1, unmatched: 0 },
    groups: [
      { service: "Entra ID", resourceType: "conditionalAccessPolicy", added: 0, removed: 0, changed: 1, unchanged: 11, total: 1, items: [
        { naturalKey: "conditionalAccessPolicy:Block legacy auth", name: "Block legacy auth", changeType: "changed", blastRadius: "tenant-lockout", fieldsTotal: 2, fields: [
          { path: "state", kind: "changed", before: "enabled", after: "enabledForReportingButNotEnforced" },
          { path: "conditions.users.excludeGroups", kind: "changed", before: ["b1ea0000-0000-4000-8000-000000000001"], after: ["b1ea0000-0000-4000-8000-000000000001", "f1aa0000-0000-4000-8000-000000000002"] },
        ] },
      ] },
      { service: "Entra ID", resourceType: "group", added: 1, removed: 1, changed: 1, unchanged: 210, total: 3, items: [
        { naturalKey: "group:Old project team", name: "Old project team", changeType: "removed", blastRadius: "access-affecting", fieldsTotal: 3, fields: [
          { path: "description", kind: "removed", before: "Project Atlas, closed in September", after: null },
          { path: "displayName", kind: "removed", before: "Old project team", after: null },
          { path: "securityEnabled", kind: "removed", before: true, after: null },
        ] },
        { naturalKey: "group:Finance", name: "Finance", changeType: "changed", blastRadius: "access-affecting", fieldsTotal: 1, fields: [{ path: "securityEnabled", kind: "changed", before: true, after: false }] },
        { naturalKey: "group:KEEL-RT-Contractors", name: "KEEL-RT-Contractors", changeType: "added", blastRadius: "access-affecting", fieldsTotal: 3, fields: [
          { path: "displayName", kind: "added", before: null, after: "KEEL-RT-Contractors" },
          { path: "membershipRule", kind: "added", before: null, after: { rule: "user.companyName -eq \"Contoso Contractors\"", processingState: "On" } },
          { path: "securityEnabled", kind: "added", before: null, after: true },
        ] },
      ] },
    ],
    notCompared: [{ resourceType: "deviceConfiguration", service: "Intune", left: "complete", right: "failed" }],
    unmatched: [],
  },
  workloads: {
    totals: { added: 0, removed: 0, changed: 1, unchanged: 41, notCompared: 1 },
    groups: [
      { service: "Exchange Online", workload: "exchange-mailbox-settings", state: "compared", added: 0, removed: 0, changed: 1, unchanged: 41, unverified: 0, unverifiedFields: 2, total: 1,
        left: { collectionId: "c0a10000-0000-4000-8000-0000000000e1", outcome: "complete", at: "2026-10-01T09:00:00Z" },
        right: { collectionId: "c0a10000-0000-4000-8000-0000000000e2", outcome: "complete", at: "2026-10-02T09:00:00Z" },
        items: [{ resourceKey: "mailbox:finance@contoso.com", changeType: "changed", fieldsTotal: 1, fields: [{ path: "mailboxSettings.ForwardingSmtpAddress", kind: "changed", before: null, after: "smtp:outside@example.com" }] }] },
      { service: "Teams", workload: "teams-org-policies", state: "not-compared", reason: "collection-failed",
        left: { collectionId: "c0a10000-0000-4000-8000-0000000000e3", outcome: "complete", at: "2026-10-01T09:00:00Z" },
        right: { collectionId: "c0a10000-0000-4000-8000-0000000000e4", outcome: "failed", at: "2026-10-02T09:00:00Z" } },
    ],
  },
  content: {
    by: "item", totals: { added: 1, removed: 1, changed: 1 }, shown: 3, total: 3,
    groups: [
      { service: "OneDrive", workload: "onedrive", leftItems: 1204, rightItems: 1204, added: 1, removed: 1, changed: 0, containers: [
        { container: "drive:b!Xc9", added: 1, removed: 1, changed: 0, items: [
          { itemKey: "01ABCDEF", name: "Budget 2027.xlsx", kind: "drive-content", changeType: "removed", beforeSha256: "3e".repeat(32), afterSha256: null, beforeBytes: 48211, afterBytes: null },
          { itemKey: "01ABCDEG", name: "Budget 2027 v2.xlsx", kind: "drive-content", changeType: "added", beforeSha256: null, afterSha256: "4f".repeat(32), beforeBytes: null, afterBytes: 49302 },
        ] },
      ] },
      { service: "Exchange Online", workload: "exchange-mail", leftItems: 30211, rightItems: 30211, added: 0, removed: 0, changed: 1, containers: [
        { container: "mailbox/c0a10000-0000-4000-8000-0000000000f1/items/inbox", added: 0, removed: 0, changed: 1, items: [
          { itemKey: "AAMkAD1", name: null, kind: "message", changeType: "changed", beforeSha256: "5a".repeat(32), afterSha256: "6b".repeat(32), beforeBytes: 18200, afterBytes: 18342 },
        ] },
      ] },
    ],
  },
};
const COMPARE_TENANTS_RESULT: CompareResult = {
  version: 1, mode: "tenants", portable: true, generatedAt: now,
  left: { kind: "snapshot", tenantRef: "sha256:5a1e00000000c0a1", snapshotId: CMP_SNAP_NEW, at: "2026-10-02T09:12:00Z" },
  right: { kind: "snapshot", tenantRef: "sha256:5a1e00000000c0b2", snapshotId: CMP_SNAP_OTHER, at: "2026-10-02T06:00:00Z" },
  settings: {
    totals: { added: 0, removed: 1, changed: 1, unchanged: 3010, notCompared: 0, unmatched: 1 },
    groups: [
      { service: "Entra ID", resourceType: "conditionalAccessPolicy", added: 0, removed: 1, changed: 1, unchanged: 10, total: 2, items: [
        { naturalKey: "conditionalAccessPolicy:Require MFA for admins", name: "Require MFA for admins", changeType: "changed", blastRadius: "tenant-lockout", fieldsTotal: 1, fields: [
          { path: "conditions.users.excludeGroups", kind: "changed", before: ["ref:group:Break-glass admins"], after: ["ref:group:Break-glass admins", "ref:unresolved"] },
        ] },
        { naturalKey: "conditionalAccessPolicy:Block legacy auth", name: "Block legacy auth", changeType: "removed", blastRadius: "tenant-lockout" },
      ] },
    ],
    notCompared: [],
    unmatched: [{ resourceType: "deviceCategory", service: "Intune", left: 3, right: 2 }],
  },
  workloads: { totals: { added: 0, removed: 0, changed: 0, unchanged: 0, notCompared: 0 }, groups: [] },
  content: { by: "holdings", totals: { inBoth: 812, onlyLeft: 31, onlyRight: 4 }, groups: [
    { service: "SharePoint", workload: "sharepoint-sites", leftItems: 843, rightItems: 816, leftBytes: 912_334_120, rightBytes: 880_102_400, inBoth: 812, onlyLeft: 31, onlyRight: 4 },
  ] },
};
const COMPARE: CompareData = { generatedAt: now, tenants: COMPARE_TENANTS, input: { from: CMP_SNAP_OLD, to: CMP_SNAP_NEW }, result: { ...COMPARE_SNAPSHOTS, names: { "b1ea0000-0000-4000-8000-000000000001": "Break-glass admins" } }, problem: null };
const COMPARE_ACROSS: CompareData = { generatedAt: now, tenants: COMPARE_TENANTS, input: { from: CMP_SNAP_NEW, to: CMP_SNAP_OTHER }, result: COMPARE_TENANTS_RESULT, problem: null };

function comparePage(data: CompareData) {
  const verdict = compareVerdict(data);
  const own = data.tenants.find((tenant) => tenant.own);
  return <>{header("Baselines", "Compare", "Put two backups side by side, or two tenants, and see what is different.")}
    <Verdict text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation"><CompareView data={data} quick={quickComparisons(own, { label: BASELINES[0].label, capture: BASELINES[0].capture && { ...BASELINES[0].capture, sourceSnapshotId: "c0a10000-0000-4000-8000-000000000005" } })} /></div></>;
}

// Site permissions audit, gap 2: each SharePoint site's stored permissions.
const SITE_HOST = "contoso.sharepoint.com";
const SITE_FINANCE = `${SITE_HOST},5e170000-0000-4000-8000-000000000001,5e170000-0000-4000-8000-000000000002`;
const SITE_ARCHIVE = `${SITE_HOST},5e170000-0000-4000-8000-000000000003,5e170000-0000-4000-8000-000000000004`;
const SITE_INTRANET = `${SITE_HOST},5e170000-0000-4000-8000-000000000005,5e170000-0000-4000-8000-000000000006`;
const SITE_READ = { status: "observed", operation: "sharepoint.site-permissions" };
const SITES: SitePermissionsData = {
  generatedAt: now,
  run: { id: "c0110000-0000-4000-8000-0000000000c5", outcome: "partial", observedTo: "2026-10-02T02:00:00Z" },
  latest: null,
  sites: [
    sitePermissionsFrom(`site:${SITE_ARCHIVE}`, { displayName: "Records archive with a long name that wraps on a phone", webUrl: `https://${SITE_HOST}/sites/records-archive-with-a-long-name-that-wraps-on-a-phone` },
      { appPermissionGrants: { status: "denied", httpStatus: 403, operation: "sharepoint.site-permissions" } }),
    sitePermissionsFrom(`site:${SITE_FINANCE}`, { displayName: "Finance", webUrl: `https://${SITE_HOST}/sites/finance`, appPermissionGrants: [
      { id: "aTowaS50fG1zLnNwLmV4dGVybmFsfGFwcDE", roles: ["fullcontrol"], applications: [{ id: "a9900000-0000-4000-8000-0000000000a1", displayName: "Payroll connector" }] },
      { id: "aTowaS50fG1zLnNwLmV4dGVybmFsfGFwcDI", roles: ["read"], applications: [{ id: "a9900000-0000-4000-8000-0000000000a2", displayName: "Board pack reader" }] },
    ] }, { appPermissionGrants: SITE_READ }),
    sitePermissionsFrom(`site:${SITE_INTRANET}`, { displayName: "Intranet", webUrl: `https://${SITE_HOST}/sites/intranet`, appPermissionGrants: [] }, { appPermissionGrants: SITE_READ }),
  ],
};

// Site permissions audit: site settings that changed between two daily reads.
// Service setting changes: each service read compared with the one before it, so the
// Changes list's service filter and grouping cover more than Entra ID and Intune.
const serviceChange = (id: string, workload: string, resourceKey: string, name: string, over: Partial<DriftRecord>, alert: string): DriftRecord => ({
  id, naturalKey: `${workload}:${resourceKey}`, resourceType: workload, changeType: "modified", blastRadius: "access-affecting",
  detectedAt: "2026-10-02T02:00:00Z", before: null, after: null, name,
  serviceRead: { workload, resourceKey, collectionId: "c0110000-0000-4000-8000-0000000000c5", previousCollectionId: "c0110000-0000-4000-8000-0000000000c4", alertId: alert, alertState: "open" },
  ...over,
});
const SERVICE_CHANGES: DriftRecord[] = [
  serviceChange("d1a00000-0000-4000-8000-0000000000d1", "sharepoint-site-settings", `site:${SITE_FINANCE}`, "Finance", {
    before: { appPermissionGrants: [] }, after: { appPermissionGrants: [{ roles: ["write"], applications: [{ displayName: "Payroll connector" }] }] },
  }, "a1e70000-0000-4000-8000-0000000000a5"),
  serviceChange("d1a00000-0000-4000-8000-0000000000d2", "exchange-mail-flow", "transport-rule:Forward finance mail", "Forward finance mail", {
    before: { State: "Disabled" }, after: { State: "Enabled" }, detectedAt: "2026-10-01T22:00:00Z",
  }, "a1e70000-0000-4000-8000-0000000000a6"),
  serviceChange("d1a00000-0000-4000-8000-0000000000d3", "teams-org-policies", "external-access:Global", "Global", {
    before: { AllowFederatedUsers: false }, after: { AllowFederatedUsers: true }, detectedAt: "2026-10-01T20:00:00Z",
  }, "a1e70000-0000-4000-8000-0000000000a7"),
  serviceChange("d1a00000-0000-4000-8000-0000000000d4", "purview-labels", "label:Confidential", "Confidential", {
    blastRadius: "cosmetic", before: { DisplayName: "Confidential" }, after: { DisplayName: "Confidential (internal)" }, detectedAt: "2026-10-01T18:00:00Z",
  }, "a1e70000-0000-4000-8000-0000000000a8"),
  serviceChange("d1a00000-0000-4000-8000-0000000000d5", "power-platform-settings", "dlp-policy:Block social connectors", "Block social connectors", {
    changeType: "removed", before: { displayName: "Block social connectors", environmentType: "AllEnvironments" }, detectedAt: "2026-10-01T16:00:00Z",
  }, "a1e70000-0000-4000-8000-0000000000a9"),
];

function sitesPage() {
  const verdict = sitesVerdict(SITES);
  return <>{header("Backup", "Sites", "Each SharePoint site and who can reach it: apps given access now, SharePoint groups and roles once KEEL reads them.")}
    <Verdict text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation"><SiteList data={SITES} /></div></>;
}

function sitePage(path: string) {
  const id = decodeURIComponent(path.slice("/sites/".length));
  const site = SITES.sites.find((entry) => entry.siteId === id);
  if (!site) return null;
  const verdict = siteVerdict(site);
  return <>{header("Backup", siteName(site), "Who can reach this SharePoint site, as of KEEL's last read.")}
    <Verdict text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation"><SiteDetail latest={null} now={now} run={SITES.run!} site={site} /></div></>;
}

// Restore: four backups (two on 30 Sept, so the time picker shows), settings across
// three services, and what changed after each backup. The harness opens on the backup
// of 30 Sept 06:00 so "Changed recently" is full; ?snapshot= picks another.
const RESTORE_SNAPSHOTS = [
  { id: "snap-4", startedAt: "2026-10-02T09:01:00Z", completedAt: "2026-10-02T09:12:00Z", resourceCount: 19 },
  { id: "snap-3", startedAt: "2026-10-01T06:00:00Z", completedAt: "2026-10-01T06:09:00Z", resourceCount: 19 },
  { id: "snap-2b", startedAt: "2026-09-30T18:00:00Z", completedAt: "2026-09-30T18:07:00Z", resourceCount: 19 },
  { id: "snap-2", startedAt: "2026-09-30T06:00:00Z", completedAt: "2026-09-30T06:08:00Z", resourceCount: 19 },
  { id: "snap-1", startedAt: "2026-09-26T06:00:00Z", completedAt: "2026-09-26T06:08:00Z", resourceCount: 19 },
];
// The other Microsoft 365 services on Restore: one restorable, one by hand, one failed, one not switched on.
const backedUp = (collectionId: string, takenAt: string, items: number) => ({ collectionId, takenAt, items, partial: false });
const RESTORE_WORKLOADS: RestoreWorkload[] = [
  { workload: "exchange-mailbox-settings", name: "Exchange mailbox settings", service: "Exchange",
    reads: ["Mailbox settings (automatic replies, time zone, working hours)", "Mailbox client access settings"],
    writes: [{ verb: "Put back", name: "Mailbox settings (automatic replies, time zone, working hours)", after: ["team member, guest, messaging and fun settings"] }],
    todo: "Settings KEEL does not restore are changed by hand in the Exchange admin center using the backup.",
    backup: backedUp("c0110000-0000-4000-8000-000000000001", "2026-10-02T06:10:00Z", 24), lastRun: null },
  { workload: "exchange-mail-flow", name: "Exchange mail flow and protection", service: "Exchange",
    reads: ["Mail flow rules", "Connectors"],
    writes: [{ verb: "Put back", name: "Mail flow rules", after: [] }],
    todo: "A deleted rule or connector is changed by hand in the Exchange admin center using the backup.",
    backup: backedUp("c0110000-0000-4000-8000-000000000002", "2026-10-02T06:12:00Z", 7), lastRun: null },
  { workload: "sharepoint-site-settings", name: "SharePoint settings", service: "SharePoint",
    reads: ["SharePoint tenant sharing and site settings", "SharePoint site list"],
    writes: [{ verb: "Put back", name: "SharePoint tenant sharing and site settings", after: [] }, { verb: "Add back", name: "SharePoint site groups", after: [] }],
    todo: "Settings KEEL does not restore are changed by hand in the SharePoint admin center using the backup.",
    backup: backedUp("c0110000-0000-4000-8000-000000000003", "2026-10-02T05:40:00Z", 41), lastRun: null },
  { workload: "onedrive-site-settings", name: "OneDrive settings", service: "SharePoint",
    reads: ["OneDrive site sharing and storage settings"], writes: [],
    todo: "KEEL does not restore OneDrive settings. Change them by hand in the SharePoint admin center using the backup.",
    backup: backedUp("c0110000-0000-4000-8000-000000000004", "2026-10-02T05:41:00Z", 3), lastRun: null },
  { workload: "teams-org-policies", name: "Teams organization policies", service: "Teams",
    reads: ["Meeting policies", "Messaging policies"], writes: [{ verb: "Put back", name: "Messaging policies", after: [] }],
    todo: "Meeting policies are changed by hand in the Teams admin center using the backup.",
    backup: backedUp("c0110000-0000-4000-8000-000000000005", "2026-10-01T06:00:00Z", 12),
    lastRun: { collectionId: "c0110000-0000-4000-8000-000000000006", outcome: "failed", at: "2026-10-02T06:00:00Z", reasons: ["timeout"] } },
  { workload: "purview-labels", name: "Purview sensitivity labels", service: "Purview",
    reads: ["Sensitivity label definitions"], writes: [{ verb: "Put back", name: "Sensitivity label definitions", after: ["mailbox client access settings"] }],
    todo: "New labels are made by hand in the Purview portal.", backup: null, lastRun: null },
  { workload: "power-platform-settings", name: "Power Platform and Power BI settings", service: "Power Platform",
    reads: ["Power Platform tenant settings"], writes: [],
    todo: "KEEL does not restore these yet. Change them by hand in the Power Platform admin center or the Fabric admin portal using the backup.",
    backup: null, lastRun: { collectionId: "c0110000-0000-4000-8000-000000000007", outcome: "disabled", at: "2026-10-02T06:00:00Z", reasons: ["not live-qualified"] } },
];

// Mail flow's two backups on Restore, and the check of two changed rules.
const WORKLOAD_BACKUPS = [
  { collectionId: "c0110000-0000-4000-8000-000000000002", takenAt: "2026-10-02T06:12:00Z", items: 7 },
  { collectionId: "c0110000-0000-4000-8000-000000000012", takenAt: "2026-09-29T06:10:00Z", items: 8 },
];
function workloadChoicesFixture(collection: string | null) {
  const chosen = WORKLOAD_BACKUPS.find((backup) => backup.collectionId === collection) ?? WORKLOAD_BACKUPS[0];
  const older = chosen !== WORKLOAD_BACKUPS[0];
  const rule = (id: string, name: string, change: "changed" | "deleted" | "same" | null) => ({
    key: `transportrule:${id}`, name, change: older ? change : null, restorable: !(older && change === "deleted"),
    reason: older && change === "deleted" ? "Deleted since this backup. KEEL does not add this back; an admin makes it again by hand from the backup." : null, tenantWide: false,
  });
  return {
    workload: "exchange-mail-flow", backups: WORKLOAD_BACKUPS, chosen,
    groups: [
      { kind: "transportRule", name: "Mail flow (transport) rules", restorable: true, reason: null, items: [
        rule("r1", "KEEL-RT Block external auto-forward", "changed"),
        rule("r2", "KEEL-RT Disclaimer for outbound mail", "changed"),
        ...(older ? [rule("r4", "KEEL-RT Route partner mail", "deleted")] : []),
        rule("r3", "KEEL-RT Quarantine executables", "same"),
      ] },
      { kind: "inboundConnector", name: "Inbound connectors", restorable: true, reason: null, items: [rule("i1", "KEEL-RT Partner inbound", "same")] },
      { kind: "acceptedDomain", name: "Accepted domains", restorable: false, reason: "KEEL does not put this kind of setting back; an admin changes it by hand from the backup.", items: [
        { key: "accepteddomain:d1", name: "contoso.example", change: null, restorable: false, reason: null, tenantWide: false },
      ] },
    ],
  };
}
// Exchange mailboxes: several picked at once, one check and one request each.
const MAILBOX_CHOICES = {
  workload: "exchange-mailbox-settings", backups: [WORKLOAD_BACKUPS[0]], chosen: WORKLOAD_BACKUPS[0],
  groups: [
    { kind: "mailbox", name: "Mailboxes", restorable: true, reason: null, items: [
      { key: "mailbox:keel-rt-shared@contoso.example", name: "KEEL-RT-Shared@contoso.example", change: null, restorable: true, reason: null, tenantWide: false },
      { key: "mailbox:keel-rt-user1@contoso.example", name: "KEEL-RT-User1@contoso.example", change: null, restorable: true, reason: null, tenantWide: false },
      { key: "mailbox:keel-rt-user2@contoso.example", name: "KEEL-RT-User2@contoso.example", change: null, restorable: true, reason: null, tenantWide: false },
    ] },
    { kind: "organization", name: "Organization", restorable: true, reason: null, items: [
      { key: "organization", name: "Organization-wide Exchange settings", change: null, restorable: true, reason: "Put back together with a mailbox: tick at least one mailbox too.", tenantWide: true },
    ] },
  ],
};
function mailboxArtifact(index: string) {
  const key = index === "0" ? "mailbox:keel-rt-shared@contoso.example" : "mailbox:keel-rt-user1@contoso.example";
  return {
    id: `mb000000-0000-4000-8000-00000000000${index}`, status: "completed", guardRefusals: [], contentEffects: [], contentEffectApprovals: [], effectsDigest: null,
    workloadRestore: {
      operations: index === "0"
        ? [{ naturalKey: `exchange:${key}:mailboxSettings`, group: "mailboxSettings", kind: "mailbox-settings", changes: [{ field: "timeZone", before: "Pacific Standard Time", after: "W. Europe Standard Time" }, { field: "automaticRepliesSetting", before: "alwaysEnabled", after: "disabled" }] }]
        : [{ naturalKey: `exchange:${key}:mailboxSettings`, group: "mailboxSettings", kind: "mailbox-settings", changes: [{ field: "timeZone", before: "UTC", after: "W. Europe Standard Time" }] }],
      manual: index === "0" ? [] : [{ resourceKey: key, field: "retention.LitigationHoldEnabled", before: false, after: true, reason: "holds are changed by a compliance administrator" }],
      refusals: [],
    },
  };
}
const WORKLOAD_ARTIFACT = {
  id: "wd000000-0000-4000-8000-000000000001", status: "completed", guardRefusals: [], contentEffects: [], contentEffectApprovals: [], effectsDigest: null,
  workloadRestore: {
    operations: [
      { resourceKey: "transportrule:r1", kind: "update", changes: [{ field: "Mode", before: "Audit", after: "Enforce" }, { field: "RejectMessageReasonText", before: null, after: "External forwarding is not allowed." }] },
      { resourceKey: "transportrule:r2", kind: "update", changes: [{ field: "Priority", before: 3, after: 1 }] },
    ],
    manual: [{ resourceKey: "transportrule:r2", field: "State", before: "Disabled", after: "Enabled", reason: "turning this on or off is a separate Enable-/Disable- step an administrator takes" }],
    refusals: [],
  },
};

const RESTORE_RESOURCES: [string, string, string][] = [
  ["conditionalAccessPolicy:Block legacy auth", "tenant-lockout", "Entra"],
  ["conditionalAccessPolicy:Require MFA for admins", "tenant-lockout", "Entra"],
  ["group:Break-glass admins", "access-affecting", "Entra"],
  ["group:All managed devices", "access-affecting", "Entra"],
  ["group:Finance", "access-affecting", "Entra"],
  ["group:Project Falcon", "access-affecting", "Entra"],
  ["group:Helpdesk Tier 1", "access-affecting", "Entra"],
  ["group:Contractors", "access-affecting", "Entra"],
  ["namedLocation:HQ egress", "access-affecting", "Entra"],
  ["namedLocation:Branch offices", "access-affecting", "Entra"],
  ["authenticationStrength:Phishing-resistant", "access-affecting", "Entra"],
  ["organizationalBranding:Contoso sign-in page", "cosmetic", "Entra"],
  ["groupLifecyclePolicy:Group expiry", "cosmetic", "Entra"],
  ["deviceConfiguration:Windows baseline", "access-affecting", "Intune"],
  ["deviceCompliancePolicy:iOS compliance", "access-affecting", "Intune"],
  ["deviceCategory:Kiosks", "cosmetic", "Intune"],
  ["transportRule:External forwarding", "access-affecting", "Exchange"],
  ["transportRule:Disclaimer footer", "cosmetic", "Exchange"],
  ["groupLifecyclePolicy:Guest expiry", "cosmetic", "Entra"],
];
const restoreChange = (naturalKey: string, kind: RestoreChange["kind"], sameUntil: string, seenAt: string, fields: RestoreChange["fields"], who: RestoreChange["who"], fieldCount = fields.length): RestoreChange =>
  ({ naturalKey, resourceType: naturalKey.split(":")[0], service: RESTORE_RESOURCES.find(([key]) => key === naturalKey)![2], kind, sameUntil, seenAt, fields, fieldCount, who });
const RESTORE_CHANGES: RestoreChange[] = [
  restoreChange("conditionalAccessPolicy:Block legacy auth", "changed", "2026-10-01T06:09:00Z", "2026-10-02T09:12:00Z",
    [{ path: "state", before: "on", after: "report only" }, { path: "conditions.users.excludeGroups", before: "none", after: "1 item" }], { names: ["Amara Okafor"], certain: true }),
  restoreChange("group:Break-glass admins", "changed", "2026-10-01T06:09:00Z", "2026-10-02T09:12:00Z",
    [{ path: "visibility", before: "Private", after: "Public" }, { path: "description", before: "Emergency access only", after: "Temporary access" }], { names: ["Lee Chen"], certain: false }),
  restoreChange("namedLocation:Branch offices", "deleted", "2026-09-30T18:07:00Z", "2026-10-01T06:09:00Z", [], null),
  restoreChange("deviceConfiguration:Windows baseline", "changed", "2026-09-30T18:07:00Z", "2026-10-01T06:09:00Z",
    [{ path: "passwordMinimumLength", before: "14", after: "8" }], { names: ["Sam Ortiz"], certain: true }, 3),
  restoreChange("transportRule:External forwarding", "changed", "2026-09-30T06:08:00Z", "2026-09-30T18:07:00Z",
    [{ path: "state", before: "enabled", after: "disabled" }], { names: ["Sam Ortiz"], certain: true }),
];

function HarnessRestore({ jobs }: { jobs: Job[] }) {
  const params = useSearchParams();
  const chosen = RESTORE_SNAPSHOTS.find((snapshot) => snapshot.id === params.get("snapshot")) ?? RESTORE_SNAPSHOTS[3];
  const isNewest = chosen.id === RESTORE_SNAPSHOTS[0].id;
  const changes = RESTORE_CHANGES.filter((change) => change.seenAt! > chosen.completedAt);
  const earlierCount = RESTORE_CHANGES.filter((change) => change.seenAt === RESTORE_SNAPSHOTS[0].completedAt).length;
  const data = { newest: { id: "snap-4", takenAt: RESTORE_SNAPSHOTS[0].completedAt }, changes, more: 0, earlier: isNewest ? { id: "snap-3", takenAt: RESTORE_SNAPSHOTS[1].completedAt, count: earlierCount } : null };
  const count = changes.length;
  return <>
    <PageHeader description="Put settings back as they were in a backup. Pick the day, choose what to undo, and someone else approves before anything changes." generatedAt={now} section="Restore"
      status={count ? { tone: "soon", label: "Changes to review" } : { tone: "fine", label: "Backups ready" }} title="Restore" />
    <RestoreSelection canApprove canRestore changes={data} key={chosen.id} lastRestore={lastRestoreTile(jobs, now)} now={now}
      resources={RESTORE_RESOURCES.map(([naturalKey, blastRadius, service]) => ({ naturalKey, resourceType: naturalKey.split(":")[0], blastRadius, service }))}
      snapshotId={chosen.id} snapshots={RESTORE_SNAPSHOTS} />
    <WorkloadServices canApprove canRestore now={now} workloads={RESTORE_WORKLOADS} />
    <div data-layer="explanation"><JobTable headingId="restore-jobs-heading" jobs={jobs.filter((item) => item.kind.startsWith("restore"))} now={now} title="Restores and checks" /></div>
  </>;
}

function Page({ path, jobs, posture }: { path: string; jobs: Job[]; posture: number }) {
  const active = jobs.some((item) => item.status === "running" || item.status === "queued");
  if (path.startsWith("/sites/")) { const detail = sitePage(path); if (detail) return detail; }
  switch (path) {
    case "/kit": return <KitPage />;
    case "/": return <DashboardView data={dashboard(posture)} pendingApprovals={2} />;
    case "/activity": case "/activity/viewer": {
      const all = activityJobs(jobs);
      const viewer = path === "/activity/viewer";
      return <>{header("Audit log", "Activity", "Everything Keel did and who decided what, newest first.", undefined, activityStatus(activityCounts(all, now)))}
        <ActivityPage canBackup={!viewer} entries={EVIDENCE} integrity={{ ok: true, status: "verified", anchoredThroughSeq: "18200", unanchoredRecords: 4 }} jobs={all}
          names={{ "group:5d1c0000-0000-4000-8000-0000000000f1": { name: "Finance approvers", resourceType: "group" } }} nextBefore={viewer ? null : "18170"} now={now} people={ACTIVITY_PEOPLE} />
        <JobRefresher active={active} />
      </>;
    }
    case "/protect": {
      const verdict = protectVerdict(COVERAGE, now);
      return <>
        <PageHeader actions={<BackUpNow disabled={false} urgent={verdict.tone !== "good"} />} description="Whether every kind of setting is backed up, how often, and whether Keel can put it back."
          generatedAt={now} section="Backup" status={protectStatus(COVERAGE)} title="What's protected" />
        <Verdict detail={protectVerdictDetail(COVERAGE.types, (type) => typeService(type).name, now)} text={verdict.text} tone={verdict.tone} />
        <div data-layer="explanation">
          <ProtectCoverage canBackup data={COVERAGE} now={now} tierStrip={<TierStrip canEditSchedules disabled={false} tiers={tierSummaries(SCHEDULES, now)} />} />
          <div className="pt-recent">
            <JobTable headingId="backup-jobs" jobs={jobs.filter((item) => item.kind === "backup" || item.kind === "collect")} now={now} title="Recent backups" />
          </div>
        </div></>;
    }
    case "/schedules": {
      const verdict = schedulesVerdict(SCHEDULES, now, SCHEDULE_FORECASTS);
      return <>{header("Backup", "Schedules", "When KEEL backs up each tier and runs its upkeep. Times are in UTC.")}
        <Verdict text={verdict.text} tone={verdict.tone} />
        <div data-layer="explanation"><ScheduleTable canEdit deferrals={[]} forecasts={SCHEDULE_FORECASTS} now={now} schedules={SCHEDULES} /></div></>;
    }
    case "/restore": return <HarnessRestore jobs={jobs} />;
    case "/incidents": return <>{header("Restore", "Incidents", "During a security incident, restore from a snapshot an investigator has checked, not simply the newest one.", "Actionable")}
      <IncidentRecovery canInvestigate incidents={[INCIDENT.incident, { id: "1c1d0000-0000-4000-8000-000000000070", title: "Lost break-glass token (drill)", owner: INVESTIGATOR, status: "closed", openedAt: "2026-09-12T10:00:00Z", closedAt: "2026-09-13T16:00:00Z" }]} now={now} selected={INCIDENT} /></>;
    case "/resilience": return resiliencePage(RESILIENCE);
    case "/resilience/unmeasured": return resiliencePage(RESILIENCE_EMPTY);
    case "/reports": return reportsPage(VALUE_REPORT);
    case "/reports/scoped": return reportsPage(VALUE_REPORT_SCOPED);
    case "/sites": return sitesPage();
    case "/compare": return comparePage(COMPARE);
    case "/compare/tenants": return comparePage(COMPARE_ACROSS);
    case "/ask": return askPage(ASK_ANSWERED);
    case "/ask/unknown": return askPage(ASK_UNKNOWN);
    case "/readiness": return readinessPage(READINESS);
    case "/readiness/ready": return readinessPage(READINESS_READY);
    case "/drift":
    case "/drift/services": {
      // The visual baseline is the plain Changes page; /drift/services adds service setting changes.
      const items = path === "/drift/services" ? [...DRIFT_DECIDED, ...SERVICE_CHANGES] : DRIFT_DECIDED;
      const verdict = changesVerdict(items, BASELINES[0].setAt, now);
      return <>{header("Baselines", "Changes", "What changed in the tenant since the approved setup. Accept what was meant to happen, undo what was not.", undefined, setupStatus(BASELINES[0], DRIFT_DECIDED))}
        <Verdict text={verdict.text} tone={verdict.tone} />
        <div data-layer="explanation">
          <ChangeList baseline={BASELINES[0]} capabilities={["read", "dispose-accept", "remediate"]} items={items} now={now} summary={DRIFT_SUMMARY} />
        </div></>;
    }
    case "/jobs/a4": { const detail = jobs.find((item) => item.id === "a4")!; return <>{header("Audit log", "Job", "What this job did and how it ended.")}<Verdict text={jobVerdict(detail, now)} tone="critical" /><a className="text-link back-link" href="#/activity"><span aria-hidden="true">←</span> All activity</a><JobDetail job={detail} now={now} /></>; }
    case "/jobs/r9": { const detail = { ...jobs.find((item) => item.id === "a3")!, id: "r9", kind: "restore", params: { artifactId: "7f3c0000-0000-4000-8000-000000000011", mode: "enforce" }, result: { applied: 2, skipped: 0 }, references: refs("marouanedefili@gmail.com", { plan: PLAN_REF }) }; return <>{header("Audit log", "Job", "What this job did and how it ended.")}<Verdict text={jobVerdict(detail, now)} /><a className="text-link back-link" href="#/activity"><span aria-hidden="true">←</span> All activity</a><JobDetail job={detail} now={now} /><RecoveryCompletion canComplete restoreRef="7f3c0000-0000-4000-8000-000000000009" /></>; }
    case "/jobs/r10": { const detail = { ...jobs.find((item) => item.id === "a4")!, id: "r10", kind: "restore", params: { artifactId: "7f3c0000-0000-4000-8000-000000000010", mode: "enforce" }, error: "Graph 400: the update to Finance was rejected", references: refs("marouanedefili@gmail.com", { plan: { ...PLAN_REF, id: "7f3c0000-0000-4000-8000-000000000010" } }) }; return <>{header("Audit log", "Job", "What this job did and how it ended.")}<Verdict text={jobVerdict(detail, now)} tone="critical" /><a className="text-link back-link" href="#/activity"><span aria-hidden="true">←</span> All activity</a><JobDetail job={detail} now={now} /><CompensationPanel canApprove canRestore failed restoreArtifactId="7f3c0000-0000-4000-8000-000000000010" /></>; }
    case "/jobs/a3": { const detail = { ...jobs.find((item) => item.id === "a3")!, result: { applied: 5, skipped: 0 } }; return <>{header("Audit log", "Job", "What this job did and how it ended.")}<Verdict text={jobVerdict(detail, now)} /><a className="text-link back-link" href="#/activity"><span aria-hidden="true">←</span> All activity</a><JobDetail job={detail} now={now} /></>; }
    case "/approvals": return <>{header("Inbox", "Approvals", "Restores, undo changes and approved-setup switches wait here for someone other than the person who asked.", undefined, { tone: "urgent", label: "4 waiting" })}
      <ApprovalInbox awaitingContentEffects={[APPROVAL_AWAITING_EFFECTS]} history={APPROVAL_HISTORY} now={now} pending={APPROVALS_PENDING} viewerId="8c1e0000-0000-4000-8000-0000000000a1" /></>;
    case "/approvals/cli-restore": return <>{header("Inbox", "Approvals", "Restores, undo changes and approved-setup switches wait here for someone other than the person who asked.", undefined, { tone: "soon", label: "1 waiting" })}
      <ApprovalInbox history={[]} now={now} pending={[
        { id: "a9e10000-0000-4000-8000-000000000145", action: "restore", params: { artifactId: CLI_PLAN_REF.id }, requestedBy: "8c1e0000-0000-4000-8000-0000000000b2", justification: "Put group expiry back to the approved setup", status: "pending", decidedBy: null, decidedAt: null, reason: null, createdAt: now, expiresAt: "2026-10-03T09:40:00Z", executor: "cli", requiredApprovals: 1, signoffs: [],
          preview: { total: 1, services: [{ name: "Entra ID", count: 1 }], changes: [{ name: "Group expiry rule", kind: "Group expiry rule", line: "Put back as the backup holds it", fields: [], moreFields: 0 }], more: 0 },
          references: { ...EMPTY_REFERENCES, people: { requested_by: personRef("8c1e0000-0000-4000-8000-0000000000b2", "ops@contoso.com") }, plan: CLI_PLAN_REF } },
      ]} viewerId="8c1e0000-0000-4000-8000-0000000000a1" /></>;
    case "/approvals/content-effects": return <>{header("Inbox", "Changes to kept or shared content", "A restore that shortens how long content is kept, releases a hold, widens sharing or deletes content needs its own approval.", undefined, { tone: "soon", label: "Waiting for you" })}
      <ContentEffectsReviewHarness /></>;
    case "/notifications": return <>{header("Settings", "Notifications", "Where Keel sends alerts, who gets which alerts, and what was sent.", undefined, { tone: "urgent", label: "Slack is failing" })}
      <NotificationsPage canConfiguration channels={CHANNELS} deliveries={DELIVERIES} escalationRules={ESCALATION_RULES} now={now} people={PEOPLE_CHOICES} subscriptions={SUBSCRIPTIONS} /></>;
    case "/notifications/viewer": return <>{header("Settings", "Notifications", "Where Keel sends alerts, who gets which alerts, and what was sent.")}
      <NotificationsPage canConfiguration={false} channels={[]} deliveries={DELIVERIES} now={now} subscriptions={[]} /></>;
    case "/integrations": case "/integrations/servicenow-off": {
      const servicenow = path === "/integrations" ? SERVICENOW_ON : SERVICENOW_OFF;
      const verdict = integrationsPageVerdict(DESTINATIONS, DESTINATION_STATUSES, servicenow);
      return <>{header("Settings", "Integrations", "Where KEEL copies its audit record, and where approvals can also be decided.")}
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation"><ServiceNowPanel status={servicenow} /><IntegrationConsole canConfiguration destinations={DESTINATIONS} statuses={DESTINATION_STATUSES} /></div></>; }
    case "/baselines": {
      const verdict = approvedVerdict(BASELINES[0], DRIFT_DECIDED, now);
      const backedUp = COVERAGE.types.filter((type) => type.reportStatus === "covered").map((type) => type.type);
      return <>{header("Baselines", "Approved setup", "How the tenant should look. Keel compares the tenant with it after every backup and lists what changed.", undefined, setupStatus(BASELINES[0], DRIFT_DECIDED))}
      <Verdict action={{ label: "Review changes", href: "/drift" }} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <ApprovedSetup backedUp={backedUp} baselines={BASELINES} canBaseline items={DRIFT_DECIDED} now={now} sources={CAPTURE_SOURCES} />
        <RecentWork jobs={jobs.filter((item) => item.kind.startsWith("baseline"))} now={now} />
      </div></>;
    }
    case "/baselines/new": return <>{header("Baselines", "New approved setup", "Copy how the tenant looked in one complete backup, so every later change is measured against it.")}
      <Verdict text="Three short steps: pick a backup, name it, then check what will happen." />
      <div data-layer="explanation">
        <BaselinesStyles />
        <CreateWizard completedSnapshotsExist disabled={false} snapshots={CAPTURE_SOURCES} today={toDay(new Date(now))} />
      </div></>;
    case "/benchmarks": { const verdict = complianceVerdict(COMPLIANCE); return <>{header("Baselines", "Compliance", "How the tenant measures against the controls KEEL checks, what each finding rests on, and where backups are kept.")}
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation"><ComplianceReport data={COMPLIANCE} now={now} /></div></>; }
    case "/principals": case "/principals/viewer": {
      // A viewer here holds users but not roles: they see everyone and can disable, not grant.
      const rolesToo = path === "/principals";
      return <>
        <PageHeader actions={rolesToo ? <a className="btn" href="#/principals?new=1"><Icon name="plus" />Add person</a> : undefined} description="Who can use Keel and what each person can do." generatedAt={now} section="Settings" status={peopleStatus(peopleCounts(PEOPLE_PAGE, now))} title="People" />
        <PeoplePage canRoles={rolesToo} canUsers now={now} people={PEOPLE_PAGE} />
      </>;
    }
    case "/alerts": { const verdict = alertsVerdict(INBOX_ALERTS, now); return <>{header("Inbox", "Alerts", "Changes that need someone: who owns each one, when it must be acknowledged, and what happened so far.")}
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation"><AlertInbox alerts={INBOX_ALERTS} canRespond now={now} /></div></>; }
    case "/setup": return <>{header("Settings", "Setup", "Connect KEEL to your Microsoft tenant: what is in place, what is waiting on you, and when the first backup can run.")}
      <Verdict text={setupVerdictFixture.text} tone={setupVerdictFixture.tone} />
      <div className="item-list" data-layer="explanation">
        {SETUP.scopes.map((setup) => <SetupProgress canCheck={SETUP.canCheck} canProvision={SETUP.canProvision} canStart key={setup.scope} now={now} setup={setup} />)}
      </div></>;
    case "/setup/checked": return <>{header("Settings", "Setup", "Connect KEEL to your Microsoft tenant: what is in place, what is waiting on you, and when the first backup can run.")}
      <Verdict text={setupCheckedVerdict.text} tone={setupCheckedVerdict.tone} />
      <div className="item-list" data-layer="explanation">
        {SETUP_CHECKED.scopes.map((setup) => <SetupProgress canCheck={SETUP_CHECKED.canCheck} canProvision={SETUP_CHECKED.canProvision} canStart checkFailed={SETUP_CHECKED.checkFailed} key={setup.scope} now={now} setup={setup} />)}
      </div></>;
    case "/emergency-changes": { const verdict = changeIntentsVerdict(INTENTS, now); return <>{header("Automation center", "Emergency changes", "Changes made outside the baseline on purpose, approved for a limited time.")}
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <h2>Approved now</h2>
        <ul className="change-intent-list">{INTENTS.filter((intent) => intent.state === "active").map((intent) => <IntentCard intent={intent} key={intent.id} now={now} />)}</ul>
        <h2>Approve an emergency change</h2>
        <ApproveIntentForm changes={INTENT_CHANGES} people={[{ id: PERSON_AMARA.id, name: PERSON_AMARA.name }, { id: PERSON_ONCALL.id, name: PERSON_ONCALL.name }]} />
        <h2>Ended</h2>
        <ul className="change-intent-list">{INTENTS.filter((intent) => intent.state !== "active").map((intent) => <IntentCard intent={intent} key={intent.id} now={now} />)}</ul>
      </div></>; }
    case "/policies/p1": case "/policies/p2": case "/policies/p3": {
      const policy = path === "/policies/p1" ? POLICY : path === "/policies/p2" ? OFF_POLICY : PAUSED_POLICY;
      const state = RULE_STATES[ruleState(policy)];
      return <>{header("Automation center", policy.name, `${RULE_KINDS[ruleKind(policy)].label}: what it watches, who it acts as, and what it did.`, undefined, { tone: state.tone === "neutral" ? "low" : state.tone, label: state.label })}
        <PolicyPage actions={policy === POLICY ? POLICY_ACTIONS : []} canEdit halted={false} initialPreview={policy === OFF_POLICY ? ACTIVATION_PREVIEW : null} now={now} policy={policy} />
      </>;
    }
    case "/policies": case "/policies/viewer": {
      const viewer = path === "/policies/viewer";
      return <>
        <PageHeader actions={viewer ? undefined : <a className="btn" href="#/policies?new=1"><Icon name="plus" />New rule</a>} description="What Keel does on its own when something changes, and who it acts as." generatedAt={now} section="Automation center" status={rulesStatus(ruleCounts(POLICIES), false)} title="Automatic rules" />
        <PoliciesPage canEdit={!viewer} halted={false} now={now} policies={POLICIES} />
      </>;
    }
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
    <AppShell
      capabilities={{ canApprove: true, canBackup: true, canConfigure: true, canPolicies: true, canRead: true, canUsers: true }}
      initialPrefs={EMPTY_PREFS}
      pendingApprovals={2}
      person={{ email: "marouanedefili@gmail.com", name: "Marouane Defili", href: "/principals#person-8c1e0000-0000-4000-8000-0000000000a1", access: accessSummary(["read", "approve", "restore", "rollback", "remediate", "investigate", "collect", "backup", "policies", "users", "roles", "configuration"]) }}
      theme="system"
    >
      <div className="page-transition" key={loading ? "loading" : `${path}:${posture}`}>
        {loading ? <PageSkeleton /> : <Page jobs={jobs} path={path} posture={posture} />}
      </div>
    </AppShell>
    <Toaster />
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
