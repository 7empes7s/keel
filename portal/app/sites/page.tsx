import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { SiteList } from "@/components/site-permissions";
import { Verdict } from "@/components/verdict";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { getSitePermissions } from "@/lib/site-permissions";
import { sitesVerdict, type SitePermissionsData } from "@/lib/site-permissions-view";

const DESCRIPTION = "Every SharePoint site: is it backed up, who owns it, and which apps and guests can reach it. Problems first.";

// Every SharePoint site with its backup, owners, apps and guests. Needs `read`,
// tenant-wide; the guard runs before any loader. Nothing on this page can change anything.
export default async function SitesPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.sitesPage);
  let data: SitePermissionsData;
  try {
    data = await getSitePermissions();
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Backup" title="Sites" /><DataUnavailable surface="Site permissions" /></>;
  }
  const verdict = sitesVerdict(data);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Backup" title="Sites" />
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <SiteList data={data} />
      </div>
    </>
  );
}
