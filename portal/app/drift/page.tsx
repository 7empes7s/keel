import { connection } from "next/server";
import { headers } from "next/headers";

import { DataUnavailable } from "@/components/data-unavailable";
import { DriftTable } from "@/components/drift-table";
import { PageHeader } from "@/components/page-header";
import { formatAge, formatTimestamp } from "@/lib/presentation";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { getDriftData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { DriftData } from "@/lib/types";

export default async function DriftPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.driftPage);
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
  const actionable = capabilities.includes("dispose-accept") || capabilities.includes("remediate");

  let data: DriftData;
  try {
    data = await getDriftData();
  } catch {
    return (
      <>
        <PageHeader
          description="Unresolved changes measured against the active recovery baseline."
          section="Changes"
          marker={actionable ? "Actionable" : "Read-only"}
          title="Drift"
        />
        <DataUnavailable surface="Drift data" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Unresolved changes measured against the active recovery baseline."
        section="Changes"
        generatedAt={data.generatedAt}
        marker={actionable ? "Actionable" : "Read-only"}
        title="Drift"
      />

      {data.baseline ? (
        <section aria-label="Active baseline context" className="context-strip">
          <span className="active-indicator">Active baseline</span>
          <strong>{data.baseline.label ?? "Unnamed baseline"}</strong>
          <span>{data.baseline.resourceCount.toLocaleString("en-GB")} resources</span>
          <span>{formatAge(data.baseline.setAt, new Date(data.generatedAt))}</span>
          <time dateTime={data.baseline.setAt}>{formatTimestamp(data.baseline.setAt)}</time>
        </section>
      ) : (
        <section className="data-error" role="alert">
          <p className="severity-label">BASELINE MISSING</p>
          <h2>Drift cannot be evaluated</h2>
          <p>No active baseline exists for this tenant.</p>
        </section>
      )}

      {data.baseline ? <DriftTable capabilities={capabilities} items={data.items} /> : null}
    </>
  );
}
