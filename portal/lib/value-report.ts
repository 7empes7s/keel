import { readFileSync } from "node:fs";

import { loadValueReport, valueReportCsv } from "../../engine/reports/value.mjs";
import { connect } from "../../engine/store/db.mjs";

import type { EntityScope } from "@/lib/principal";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { PERIODS, type PeriodKey, type ValueReport } from "@/lib/value-report-view";

// Roadmap task-100: the server side of the value report. The engine reader does the
// counting; this file picks the period, narrows the scope and reads the configured
// time-saving estimate. An entity-scoped reader's scope comes from the read guard and
// is applied by the engine before anything is counted.

interface KeelClient {
  end(): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
  period: PeriodKey;
  entity?: string | null;
  now?: Date;
}): Promise<ValueReport> {
  const ref = tenantRef();
  const path = valueEstimatePath();
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return (await loadValueReport(client, {
      tenantRef: ref,
      from: new Date(now.getTime() - PERIODS[period].days * DAY_MS),
      to: now,
      now,
      scope: reportScope(scope, entity),
      estimate: readEstimate(path),
      estimateSource: path,
    })) as ValueReport;
  } finally {
    await client.end();
  }
}

export function reportCsv(report: ValueReport): string {
  return valueReportCsv(report) as string;
}
