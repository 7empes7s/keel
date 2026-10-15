import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { SiteList } from "@/components/site-permissions";
import { Verdict } from "@/components/verdict";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { getSitePermissions } from "@/lib/site-permissions";
import { sitesVerdict, type SitePermissionsData } from "@/lib/site-permissions-view";

const DESCRIPTION = "Each SharePoint site and who can reach it: apps given access now, SharePoint groups and roles once KEEL reads them.";

// Gap 2 of the site permissions audit: needs `read`, tenant-wide; the guard runs before
// any loader. Nothing on this page can change anything.
export default async function SitesPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.sitesPage);
  let data: SitePermissionsData;
  try {
    data = await getSitePermissions();
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Protect" title="Sites" /><DataUnavailable surface="Site permissions" /></>;
  }
  const verdict = sitesVerdict(data);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Protect" title="Sites" />
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <SiteList data={data} />
      </div>
    </>
  );
}
