import { readFileSync } from "node:fs";

import { knownEntities } from "../../engine/query/execute.mjs";
import { loadValueReport, valueReportCsv } from "../../engine/reports/value.mjs";
import { connect } from "@/lib/db";

import type { EntityScope } from "@/lib/principal";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import type { ReportWindow, ValueReport } from "@/lib/value-report-view";

// Roadmap task-100: the server side of the value report. The engine reader does the
// counting; this file picks the period, narrows the scope and reads the configured
// time-saving estimate. An entity-scoped reader's scope comes from the read guard and
// is applied by the engine before anything is counted.

interface KeelClient {
  end(): Promise<void>;
}

/** Where an operator keeps the time-saving estimate. Unset means no hours are shown. */
export function valueEstimatePath(): string | null {
  const configured = process.env.KEEL_VALUE_ESTIMATE_PATH;
  return configured && configured.length > 0 ? configured : null;
}

function readEstimate(path: string | null): unknown {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8")) as unknown;
  } catch {
    // An unreadable estimate is reported as invalid, never replaced by a default.
    return "unreadable";
  }
}

/**
 * The reader's report scope: their own scope, optionally narrowed to one entity. An
 * entity outside an entity-scoped reader's scope gives an empty scope, never a wider one.
 */
export function reportScope(scope: EntityScope, entity: string | null): EntityScope {
  if (!entity) return scope;
  if (scope.central) return { central: false, entities: [entity] };
  return { central: false, entities: scope.entities.includes(entity) ? [entity] : [] };
}

export async function getValueReport({ scope, period, entity = null, now = new Date() }: {
  scope: EntityScope;
  period: ReportWindow;
  entity?: string | null;
  now?: Date;
}): Promise<ValueReport> {
  const ref = tenantRef();
  const path = valueEstimatePath();
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return (await loadValueReport(client, {
      tenantRef: ref,
      from: new Date(period.from),
      to: new Date(period.to),
      now,
      scope: reportScope(scope, entity),
      estimate: readEstimate(path),
      estimateSource: path,
    })) as ValueReport;
  } finally {
    await client.end();
  }
}

/**
 * The owners a reader can narrow the report to: every owner the tenant's ownership
 * evidence names for a tenant-wide reader, only their own for an entity-scoped one.
 * An unreadable list is empty, so the page simply shows no owner filter.
 */
export async function getReportOwners(scope: EntityScope): Promise<string[]> {
  if (!scope.central) return [...scope.entities].sort();
  try {
    const client = (await connect(databaseUrl())) as KeelClient;
    try {
      return (await knownEntities(client, { tenantRef: tenantRef() })) as string[];
    } finally {
      await client.end();
    }
  } catch {
    return [];
  }
}

export function reportCsv(report: ValueReport): string {
  return valueReportCsv(report) as string;
}
