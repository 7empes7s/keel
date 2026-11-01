import assert from "node:assert/strict";
import { test } from "node:test";

import { typeInfo } from "../../engine/insights/taxonomy.mjs";
import { typeService } from "@/lib/baselines-view";
import { workloadLiveNote } from "@/lib/protect-view";
import type { CoverageData, WorkloadLiveRecord } from "@/lib/types";

// What's protected (backlog B13 and D18): To Do settings were filed under Entra ID, and
// each workload live record drew its own "proven on this tenant" note at the top.

test("To Do, Forms and Office app org settings sit under Microsoft 365 apps, not Entra ID", () => {
  for (const type of ["todoSettings", "formsSettings", "microsoft365AppsInstallationOptions", "appsAndServicesSettings"]) {
    assert.equal(typeInfo(type)?.service, "Microsoft 365 apps", type);
    assert.equal(typeService(type).name, "Microsoft 365 apps", type);
  }
  assert.equal(typeInfo("todoSettings")?.name, "Microsoft To Do setting");
  assert.equal(typeInfo("organization")?.service, "Entra");
});

const record = (label: string, live: boolean): WorkloadLiveRecord =>
  ({ label, live, observedAt: "2026-10-20T10:00:00.000Z", expiresAt: "2026-11-19T10:00:00.000Z", reason: live ? null : "the key that checks live records is not set up on this server" }) as unknown as WorkloadLiveRecord;
const coverage = (workloads: WorkloadLiveRecord[]) => ({ liveEvidence: { keyConfigured: true, workloads } }) as unknown as CoverageData;

test("workload live records make one note, with dates and reasons behind a click", () => {
  assert.equal(workloadLiveNote(coverage([])), null);
  const four = workloadLiveNote(coverage([record("SharePoint site settings", true), record("Teams settings", true), record("Exchange settings", false), record("Purview settings", false)]));
  assert.equal(four?.summary, "Restore proven on this tenant by a live run: SharePoint site settings and Teams settings. Not proven yet: Exchange settings and Purview settings. Their live runs do not count yet.");
  assert.equal(four?.lines.length, 4);
  assert.equal(four?.summary.match(/proven on this tenant/g)?.length, 1);
  assert.equal(workloadLiveNote(coverage([record("SharePoint site settings", false)]))?.summary,
    "Restore not proven on this tenant yet: SharePoint site settings. Its live run does not count yet.");
});
