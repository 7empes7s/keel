import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { ReadinessPage as ReadinessBody } from "@/components/readiness/readiness-page";
import { ALERT_RESPOND_CAPABILITY } from "@/lib/alerts";
import { getReadinessData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { readinessStatus, type ReadinessData } from "@/lib/readiness-view";

const DESCRIPTION = "Whether the emergency accounts would let an administrator in when everything else fails, and whether anyone has used them.";

// Emergency access (portal audit, one design). Reading needs `read` held tenant-wide;
// the guard runs before any loader, and the engine reader is pinned to this tenant.
// Registering, editing and retiring accounts and recording tests show only for people
// who manage configuration; Acknowledge and Resolve only with `dispose-accept`. Each
// route checks again. These changes are records in KEEL; none writes to the tenant.
export default async function ReadinessPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.readinessPage);
  let data: ReadinessData;
  try {
    data = await getReadinessData();
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Restore" title="Emergency access" /><DataUnavailable surface="Emergency account checks" /></>;
  }
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Restore" status={readinessStatus(data)} title="Emergency access" />
      <ReadinessBody
        canConfigure={access.capabilities.includes("configuration")}
        canRespond={access.capabilities.includes(ALERT_RESPOND_CAPABILITY)}
        data={data}
      />
    </>
  );
}
