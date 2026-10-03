import { connection } from "next/server";

import { CoverageReport } from "@/components/coverage-report";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { formatTimestamp } from "@/lib/presentation";
import { getCoverageData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { CoverageData } from "@/lib/types";

export default async function CoveragePage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.coveragePage);

  let data: CoverageData;
  try {
    data = await getCoverageData();
  } catch {
    return (
      <>
        <PageHeader
          description="Every known configuration type, including failed collections and missing adapters."
          section="Protect"
          marker="Read-only"
          title="Coverage"
        />
        <DataUnavailable surface="Coverage data" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Every known configuration type, including failed collections and missing adapters."
        section="Protect"
        generatedAt={data.generatedAt}
        marker="Read-only"
        title="Coverage"
      />

      <aside className="honesty-note" aria-label="Fidelity interpretation">
        <strong>Declaration is not verification.</strong>
        <p>
          A fidelity declaration describes adapter intent. It is shown as verified only
          when recovery-drill evidence exists. A completed zero-item collection is successful, and
          catalog types without a collecting descriptor are Not covered.
        </p>
        <span>
          Last completed snapshot: {formatTimestamp(data.snapshot?.completedAt ?? null)}
        </span>
      </aside>

      <CoverageReport data={data} />
    </>
  );
}
