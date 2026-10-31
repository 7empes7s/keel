// Portal audit 31 Oct 2026, metric 5: "Restore proven" read "107 of 192" on the
// Overview, "0 of 107" on What's protected and "none proven yet" on Setup. Each page now
// counts it with engine/coverage/restoreProof.mjs, so one tenant gives one answer.
import assert from "node:assert/strict";
import { test } from "node:test";

import { protectionHeadline } from "../../engine/coverage/protectionHeadline.mjs";
import { overviewTiles } from "@/lib/overview-view";
import { normalizeCoverageType } from "@/lib/portal-data";
import { protectCounts } from "@/lib/protect-view";
import { serviceStatuses } from "@/lib/setup-services";
import type { DashboardData, ProtectionHeadline } from "@/lib/types";
import { headlineEntries, workloadKinds } from "@/lib/workload-kinds";

const NOW = "2026-10-31T18:00:00.000Z";
const READ_AT = "2026-10-31T12:00:00.000Z";
const LIVE_AT = "2026-10-20T08:00:00.000Z";

const op = (claim: string, live?: boolean) => ({
  claim, credentialMode: "restorer", idOutcome: null, handler: null, proofRef: null, projection: "reviewed-empty",
  ...(live === undefined ? {} : { liveRecord: { live, observedAt: LIVE_AT, expiresAt: "2026-11-19T08:00:00.000Z", reason: null } }),
});
const writes = (type: string, claim: string, live?: boolean) => ({
  qualification: { decision: "automated", reason: null, softRestoreCandidate: false, remapping: {} },
  writeCapability: { resourceType: type, operations: { create: op(claim, live), update: op(claim, live), delete: op("unsupported"), "restore-soft-deleted": op("unsupported") } },
});
// Engine coverage entries (engine/coverage/report.mjs), as the Overview reads them.
const raw = (type: string, fields: Record<string, unknown> = {}) => ({
  type, status: "covered", stale: false, itemCount: 2, lastCollectedAt: READ_AT, adapter: `graph/${type}`, outcome: "complete",
  detail: null, fidelity: { declared: "read-only", verifiedBy: null }, criticality: "tier1", blastRadius: null, remappable: null,
  ...fields,
});

const RAW = [
  raw("conditionalAccessPolicy", writes("conditionalAccessPolicy", "live-qualified", true)),
  raw("namedLocation", writes("namedLocation", "live-qualified", true)),
  raw("group", { fidelity: { declared: "partial", verifiedBy: { kind: "fidelity-drill", at: "2026-10-01T10:00:00.000Z", measuredFidelity: "partial" } } }),
  raw("user", writes("user", "fixture-tested")),
  raw("deviceConfiguration", writes("deviceConfiguration", "fixture-tested")),
  raw("deviceCompliancePolicy", { ...writes("deviceCompliancePolicy", "fixture-tested"), status: "failed", outcome: "failed" }),
  raw("organization"),
  raw("directoryRoleTemplate", { fidelity: { declared: "unprotectable", verifiedBy: null } }),
  raw("managedDevice", { status: "not-covered", adapter: null, outcome: null, lastCollectedAt: null, fidelity: { declared: null, verifiedBy: null } }),
];
const WORKLOADS = workloadKinds([
  { workload: "exchange-mail-flow", status: "complete", resources: 4, observation: { endedAt: READ_AT } },
  { workload: "teams-settings", status: "partial", resources: 3, observation: { endedAt: READ_AT } },
  { workload: "power-platform", status: "disabled", resources: null, observation: null },
], new Set(["exchange-mail-flow"]));

function dashboard(headline: ProtectionHeadline): DashboardData {
  return {
    generatedAt: NOW, activeBaseline: null, lastCollection: null, lastCompletedCollectionAt: null,
    openDriftByBlastRadius: [], openDriftTotal: 0, driftTrend: [],
    coverage: { covered: 0, failed: 0, notCovered: 0, neverCollected: 0, stale: 0, total: 0 },
    evidence: { ok: true, chainLength: 0 }, alerts: [], headline,
  } as DashboardData;
}

test("the Overview tile, What's protected and Setup show the same restore proven count", () => {
  // Overview: the engine headline over the report's entries plus the workloads.
  const headline = protectionHeadline([...RAW, ...headlineEntries(WORKLOADS)] as never) as ProtectionHeadline;
  const tile = overviewTiles(dashboard(headline), null).find((entry) => entry.key === "restore")!;

  // What's protected and Setup: the portal's normalised kinds, workloads added.
  const kinds = [...RAW.map((entry) => normalizeCoverageType(entry)), ...WORKLOADS];
  const counts = protectCounts(kinds);

  // Two writes ran live and one drill measured the group; the workload with a declared
  // write, two fixture-tested writers and the failed backup's writer only pass tests.
  assert.deepEqual(
    { proven: headline.proof.proven, tested: headline.proof.tested, restorable: headline.proof.restorable },
    { proven: 3, tested: 3, restorable: 7 },
  );
  assert.deepEqual({ proven: counts.proven, tested: counts.tested, restorable: counts.restorable }, {
    proven: headline.proof.proven, tested: headline.proof.tested, restorable: headline.proof.restorable,
  });
  assert.equal(tile.value, `${counts.proven} of ${counts.restorable}`);
  assert.equal(tile.href, "/protect?health=proven", "the tile opens the list it counts");
  assert.equal(tile.detail, "Last proven 11 days ago");
  assert.equal(headline.lastProvenRestoreAt, LIVE_AT, "the headline's last proven restore is the same rule");

  // Setup: one line per service; the lines add up to the same numbers.
  const lines = serviceStatuses(kinds, NOW).map((status) => status.restore.text);
  let proven = 0;
  let restorable = 0;
  for (const line of lines) {
    const match = /^(\d+) of \d+ can be put back, (?:(\d+) proven on this tenant|none proven yet)/.exec(line);
    if (!match) continue;
    restorable += Number(match[1]);
    proven += Number(match[2] ?? 0);
  }
  assert.deepEqual({ proven, restorable }, { proven: counts.proven, restorable: counts.restorable }, lines.join("\n"));
});

test("with nothing run live, every page says none proven and points at the tested ones", () => {
  const onlyTested = RAW.filter((entry) => !["conditionalAccessPolicy", "namedLocation", "group"].includes(entry.type));
  const headline = protectionHeadline(onlyTested as never) as ProtectionHeadline;
  const tile = overviewTiles(dashboard(headline), null).find((entry) => entry.key === "restore")!;
  assert.equal(tile.value, `0 of ${headline.proof.restorable}`);
  assert.equal(tile.detail, "3 pass tests, none run live yet");
  assert.equal(tile.tone, "soon");
  const counts = protectCounts(onlyTested.map((entry) => normalizeCoverageType(entry)));
  assert.equal(counts.proven, 0);
  assert.equal(counts.restorable, headline.proof.restorable);
  const entra = serviceStatuses(onlyTested.map((entry) => normalizeCoverageType(entry)), NOW).find((status) => status.code === "Entra")!;
  assert.match(entra.restore.text, /none proven yet, \d+ pass(es)? tests only$/);
});
