import { headers } from "next/headers";
import { connection } from "next/server";

import { GET as loadSetup } from "@/app/api/setup/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { CheckAgain } from "@/components/setup/check-again";
import { SetupPage as SetupBody } from "@/components/setup/setup-page";
import { getCoverageData } from "@/lib/portal-data";
import { withWorkloadKinds } from "@/lib/protect-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { serviceStatuses, type ServiceStatus } from "@/lib/setup-services";
import { setupStatus, type SetupState } from "@/lib/setup-view";

const DESCRIPTION = "Connect Keel to your Microsoft tenant: what is in place, what waits on you, and when the first backup can run.";

// Setup (portal audit, pick A: two checklists side by side). Read access and write
// access are set up separately, so a missing restore step never holds up the first
// backup. Starting and continuing need `approve`; the first backup needs `collect`.
export default async function SetupPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.setupPage);
  let data: SetupState;
  try {
    const response = await loadSetup(new Request("http://localhost/api/setup", { headers: await headers() }));
    if (!response.ok) throw new Error("Setup unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader section="Settings" title="Setup" description={DESCRIPTION} /><DataUnavailable surface="Setup" /></>;
  }
  // The service lines read the same coverage report as What's protected. If it cannot
  // be read, setup still works and the section says so.
  let services: ServiceStatus[] | null = null;
  try {
    services = serviceStatuses(withWorkloadKinds(await getCoverageData()).types, data.generatedAt);
  } catch {
    services = null;
  }
  return <>
    <PageHeader actions={<CheckAgain />} section="Settings" title="Setup" description={DESCRIPTION} generatedAt={data.generatedAt} status={setupStatus(data)} />
    <SetupBody
      canBackup={access.capabilities.includes("collect")}
      canStart={access.capabilities.includes("approve")}
      services={services}
      state={data}
    />
  </>;
}
