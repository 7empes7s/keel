import { notFound } from "next/navigation";
import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { SiteDetail } from "@/components/site-permissions";
import { Verdict } from "@/components/verdict";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { getSitePermissions } from "@/lib/site-permissions";
import { siteName, siteVerdict, type SitePermissionsData } from "@/lib/site-permissions-view";

const PARENTS = [{ href: "/sites", label: "Sites" }];
const DESCRIPTION = "Who can reach this SharePoint site, as of KEEL's last read.";

function decoded(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

// Gap 2 of the site permissions audit: one site's stored permissions. Needs `read`,
// tenant-wide; the guard runs before any loader.
export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  await requireReadAccess(DATA_SURFACES.sitePage);
  const siteId = decoded((await params).id);
  let data: SitePermissionsData;
  try {
    data = await getSitePermissions(siteId);
  } catch {
    return <><PageHeader description={DESCRIPTION} parents={PARENTS} section="Backup" title="Site" /><DataUnavailable surface="This site" /></>;
  }
  const site = data.sites[0];
  if (!site || !data.run) notFound();
  const verdict = siteVerdict(site);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} parents={PARENTS} section="Backup" title={siteName(site)} />
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <SiteDetail latest={data.latest} now={data.generatedAt} run={data.run} site={site} />
      </div>
    </>
  );
}
