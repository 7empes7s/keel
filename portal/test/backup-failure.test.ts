import assert from "node:assert/strict";
import { test } from "node:test";

import { failureReason, retryPlan, setupPermissionHref } from "@/lib/backup-failure";
import { serviceStatuses } from "@/lib/setup-services";
import type { CoverageOutcomeDetail, CoverageType } from "@/lib/types";
import { workloadKinds } from "@/lib/workload-kinds";

const NOW = "2026-10-31T12:00:00.000Z";
const TIERS = ["tier1", "tier2", "tier3"];

function detail(extra: Partial<CoverageOutcomeDetail>): CoverageOutcomeDetail {
  return { httpStatus: null, graphCode: null, message: null, endpoint: null, apiVersion: "v1.0", pagesCompleted: null, startedAt: null, completedAt: null, ...extra };
}

function kind(type: string, extra: Partial<CoverageType> = {}): CoverageType {
  return {
    type, reportStatus: "failed", protectionState: "failed", stale: false, itemCount: 0, lastCollectedAt: NOW, adapter: `graph/${type}`,
    outcome: "failed", detail: null, fidelity: { declared: "full", measured: null, verifiedAt: null }, criticality: "tier1", blastRadius: null, remappable: null,
    ...extra,
  };
}

test("a kind that did not fail has no failure reason", () => {
  assert.equal(failureReason(kind("user", { reportStatus: "covered", protectionState: "protected", outcome: "complete", itemCount: 3 })), null);
});

test("a refused Graph read names the permission it needs and links to that row on Setup", () => {
  const reason = failureReason(kind("authenticationMethodsPolicy", {
    detail: detail({ httpStatus: 403, graphCode: "Authorization_RequestDenied", message: "Insufficient privileges", endpoint: "/v1.0/policies/authenticationMethodsPolicy" }),
  }))!;
  assert.equal(reason.tone, "urgent");
  assert.deepEqual(reason.needs.map((need) => need.name), ["Policy.Read.All"]);
  assert.equal(reason.needs[0].words, "Read sign-in rules and other policies");
  assert.equal(reason.needs[0].href, "/setup?perm-app=collector&perm-q=Policy.Read.All#setup-permissions");
  // From the path alone it is Microsoft's usual permission, so Setup says whether it is missing.
  assert.match(reason.text, /needs the permission Policy\.Read\.All .*Setup shows which one is missing/);
});

test("a permission Microsoft names in its refusal wins over the path's usual one", () => {
  const reason = failureReason(kind("namedLocation", {
    detail: detail({ httpStatus: 403, message: "API requires one of 'Policy.ReadWrite.ConditionalAccess, Policy.Read.All'", endpoint: "/v1.0/identity/conditionalAccess/namedLocations" }),
  }))!;
  assert.equal(reason.needs[0].name, "Policy.ReadWrite.ConditionalAccess");
  assert.match(reason.text, /does not hold the permission Policy\.ReadWrite\.ConditionalAccess/);
  // Setup does not list that one, so the link opens the whole permission list.
  assert.equal(reason.needs[0].href, "/setup#setup-permissions");
});

test("a confirmed missing scope or role names it; a missing licence links nowhere", () => {
  const scope = failureReason(kind("roleEligibilitySchedule", {
    diagnosis: { diagnosis: "missing-scope", original: { httpStatus: 403, graphCode: null }, confirmed: { consentScopes: ["RoleManagement.Read.Directory", "RoleEligibilitySchedule.Read.Directory"] } },
  }))!;
  assert.deepEqual(scope.needs.map((need) => need.name), ["RoleManagement.Read.Directory"]);
  assert.match(scope.text, /does not hold the permission RoleManagement\.Read\.Directory/);
  const role = failureReason(kind("accessReviewScheduleDefinition", {
    diagnosis: { diagnosis: "missing-role", original: { httpStatus: 403, graphCode: null }, confirmed: { requiredRoles: ["Global Reader"] } },
  }))!;
  assert.deepEqual(role.needs.map((need) => [need.type, need.name]), [["role", "Global Reader"]]);
  const licence = failureReason(kind("purview-labels", { diagnosis: { diagnosis: "missing-license", original: { httpStatus: 403, graphCode: null } } }))!;
  assert.equal(licence.tone, "neutral");
  assert.deepEqual(licence.needs, []);
});

test("a refused workload read lists the permissions and roles that workload declares", () => {
  const [sharePoint] = workloadKinds([{ workload: "sharepoint-site-settings", status: "failed", observation: { startedAt: NOW, endedAt: NOW }, reasons: ["sites read: HTTP 403 Access denied"] }], new Set());
  const reason = failureReason(sharePoint)!;
  const names = reason.needs.map((need) => need.name);
  assert.ok(names.includes("Sites.Read.All"));
  assert.ok(names.includes("SharePoint Administrator"));
  assert.equal(reason.needs.find((need) => need.name === "SharePoint Administrator")!.type, "role");
  assert.ok(reason.needs.every((need) => need.href.startsWith("/setup")));
});

test("other failures say what happened in plain words, without a permission", () => {
  const timeout = failureReason(kind("retentionLabel", { outcome: "partial", itemCount: 17, detail: detail({ httpStatus: 504, graphCode: "GatewayTimeout", message: "page 4 timed out" }) }))!;
  assert.match(timeout.text, /^Microsoft 365 did not answer in time/);
  assert.deepEqual(timeout.needs, []);
  const throttled = failureReason(kind("user", { detail: detail({ httpStatus: 429 }) }))!;
  assert.match(throttled.text, /slowed Keel down/);
  const unknown = failureReason(kind("user"))!;
  assert.match(unknown.text, /Keel could not read it/);
});

test("every failed kind can be run again: its tier, the settings backup, or a full read", () => {
  assert.deepEqual(retryPlan(kind("user", { criticality: "tier2" }), TIERS), { kind: "tier", tier: "tier2" });
  assert.deepEqual(retryPlan(kind("exchange-mail-flow", { criticality: null }), TIERS), { kind: "workloads" });
  assert.deepEqual(retryPlan(kind("keelTestUntiered", { criticality: null }), TIERS), { kind: "full" });
});

test("Setup's service tile links a refused read to its permission", () => {
  const [entra] = serviceStatuses([kind("authenticationMethodsPolicy", {
    detail: detail({ httpStatus: 403, endpoint: "/v1.0/policies/authenticationMethodsPolicy" }),
  })], NOW);
  assert.match(entra.blocker!.text, /^Authentication methods policy: Microsoft refused the read/);
  assert.deepEqual(entra.blocker!.fix, { label: "Check Policy.Read.All", href: setupPermissionHref("Policy.Read.All") });
});
