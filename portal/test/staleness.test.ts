import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { ProtectCoverage } from "@/components/protect-coverage";
import { buildAlerts } from "@/lib/portal-data";
import type { CoverageData, CoverageType, DashboardData } from "@/lib/types";
import { recordValues } from "./record-fields";

function coverageType(overrides: Partial<CoverageType> = {}): CoverageType {
  return {
    type: "conditionalAccessPolicy",
    reportStatus: "covered",
    protectionState: "protected",
    stale: false,
    itemCount: 3,
    lastCollectedAt: "2026-09-08T12:00:00.000Z",
    adapter: "graph-conditional-access",
    outcome: "complete",
    detail: null,
    fidelity: {
      declared: "full",
      measured: "full",
      verifiedAt: "2026-09-08T12:00:00.000Z",
    },
    criticality: "tier1",
    blastRadius: "tenant-lockout",
    remappable: true,
    ...overrides,
  };
}

function coverageData(type: CoverageType): CoverageData {
  return {
    generatedAt: "2026-09-08T13:00:00.000Z",
    snapshot: null,
    summary: {
      covered: type.stale ? 0 : 1,
      failed: 0,
      notCovered: 0,
      neverCollected: 0,
      unavailable: 0,
      stale: type.stale ? 1 : 0,
      total: 1,
    },
    types: [type],
  };
}

function dashboardData(stale: number): Pick<
  DashboardData,
  "activeBaseline" | "lastCollection" | "coverage" | "evidence"
> {
  return {
    activeBaseline: {
      id: "baseline-1",
      label: "Baseline",
      description: null,
      setAt: "2026-09-08T12:00:00.000Z",
      setBy: "operator@example.com",
      active: true,
      resourceCount: 1,
    },
    lastCollection: {
      completedAt: "2026-09-08T12:00:00.000Z",
      status: "complete",
    },
    coverage: {
      covered: 1 - stale,
      failed: 0,
      notCovered: 0,
      neverCollected: 0,
      unavailable: 0,
      stale,
      total: 1,
    },
    evidence: { ok: true, chainLength: 1 },
  };
}

const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
const renderCoverage = (data: CoverageData) => renderToStaticMarkup(
  createElement(AppRouterContext.Provider, { value: router as never }, createElement(ProtectCoverage, { data, now: data.generatedAt, canBackup: true })),
);

// Task-131: freshness is a sentence on the kind's row; the raw time is in its record.
test("a stale type renders as out of date and not as failed", () => {
  const html = renderCoverage(coverageData(coverageType({ stale: true })));

  assert.match(html, /Out of date: last backed up 1 hour ago, longer ago than its tier allows\./);
  assert.match(html, /health-stale/);
  assert.ok(recordValues(html, "Last collected").some((value) => value.includes("<code>2026-09-08T12:00:00")));
  assert.doesNotMatch(html, /health-failed/);
});

test("a fresh type does not render as out of date", () => {
  const html = renderCoverage(coverageData(coverageType()));

  assert.match(html, /health-ok|health-empty/);
  assert.doesNotMatch(html, /Out of date: last backed up/);
});

test("the dashboard alert appears only when at least one type is stale", () => {
  const staleAlerts = buildAlerts(dashboardData(1));
  const freshAlerts = buildAlerts(dashboardData(0));

  assert.deepEqual(staleAlerts, [{
    key: "stale",
    severity: "warning",
    title: "1 setting type is out of date or never backed up",
    detail: "They have no backup recent enough for how critical they are. Run a backup.",
    href: "/protect?health=out-of-date",
  }]);
  assert.equal(freshAlerts.some((alert) => alert.title.includes("out of date")), false);
});
