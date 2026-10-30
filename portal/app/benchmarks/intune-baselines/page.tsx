import { connection } from "next/server";

import { IntuneBaselinesPage } from "@/components/compliance/intune-baselines-page";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { getIntuneBaselineData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { baselinesStatus, type IntuneBaselineData } from "@/lib/intune-baselines-view";

const DESCRIPTION = "Every setting of Microsoft's Intune security baselines, checked against all your settings catalog policies.";
const BACK = [{ href: "/benchmarks", label: "Compliance" }];

// Intune security baselines: read from the tenant's own Intune templates and matched
// setting by setting against every settings catalog policy, so a setting applied by any
// policy counts. Read-only.
export default async function IntuneBaselinesRoute() {
  await connection();
  await requireReadAccess(DATA_SURFACES.intuneBaselinesPage);

  let data: IntuneBaselineData;
  try {
    data = await getIntuneBaselineData();
  } catch {
    return (
      <>
        <PageHeader parents={BACK} description={DESCRIPTION} section="Baselines" title="Intune security baselines" />
        <DataUnavailable surface="Intune security baselines" />
      </>
    );
  }

  return (
    <>
      <PageHeader parents={BACK} description={DESCRIPTION} generatedAt={data.generatedAt} section="Baselines" status={baselinesStatus(data)} title="Intune security baselines" />
      <IntuneBaselinesPage data={data} />
    </>
  );
}
