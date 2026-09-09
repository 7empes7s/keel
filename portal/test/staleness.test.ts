import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CoverageReport } from "@/components/coverage-report";
import { buildAlerts } from "@/lib/portal-data";
import type { CoverageData, CoverageType, DashboardData } from "@/lib/types";

function coverageType(overrides: Partial<CoverageType> = {}): CoverageType {
  return {
    type: "conditionalAccessPolicy",
    reportStatus: "covered",
    protectionState: "protected",
    stale: false,
    itemCount: 3,
    lastCollectedAt: "2026-09-08T12:00:00.000Z",
    adapter: "graph-conditional-access",
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
      covered: 1,
      failed: 0,
      notCovered: 0,
      neverCollected: 0,
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
      covered: 1,
      failed: 0,
      notCovered: 0,
      neverCollected: 0,
      stale,
      total: 1,
    },
    evidence: { ok: true, chainLength: 1 },
  };
}

test("a stale type renders as stale and not as failed", () => {
  const html = renderToStaticMarkup(
    createElement(CoverageReport, { data: coverageData(coverageType({ stale: true })) }),
  );

  assert.match(html, /<span class="stale-badge">Stale<\/span>/);
  assert.match(html, /Last collected 8 Sept 2026, 12:00 UTC/);
  const typeRow = html.match(/<tr>.*?conditionalAccessPolicy.*?<\/tr>/)?.[0];
  assert.ok(typeRow);
  assert.doesNotMatch(typeRow, /state-failed/);
});

test("a fresh type does not render as stale", () => {
  const html = renderToStaticMarkup(
    createElement(CoverageReport, { data: coverageData(coverageType()) }),
  );

  assert.match(html, />Fresh<\/span>/);
  assert.doesNotMatch(html, /stale-badge/);
});

test("the dashboard alert appears only when at least one type is stale", () => {
  const staleAlerts = buildAlerts(dashboardData(1));
  const freshAlerts = buildAlerts(dashboardData(0));

  assert.deepEqual(staleAlerts, [{
    severity: "warning",
    title: "1 catalog type is stale",
    detail: "Run a collection for the stale types; they were collected successfully but are no longer recent enough for their tier.",
  }]);
  assert.equal(freshAlerts.some((alert) => alert.title.includes("stale")), false);
});
