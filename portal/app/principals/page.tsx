import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadPrincipals } from "@/app/api/principals/route";
import { PageHeader } from "@/components/page-header";
import { DataUnavailable } from "@/components/data-unavailable";
import { PrincipalDetails } from "@/components/principal-details";
import type { PrincipalView } from "@/lib/principals";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

export default async function PrincipalsPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.principalsPage);
  let data: { principals: PrincipalView[]; generatedAt: string };
  try {
    const response = await loadPrincipals(new Request("http://localhost/api/principals", { headers: await headers() }));
    if (!response.ok) throw new Error("Principals unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader eyebrow="Administration" title="Principals" description="Identities, role grants, and effective capabilities." /><DataUnavailable surface="Principals" /></>;
  }
  return <>
    <PageHeader eyebrow="Administration" title="Principals" description="Identities, role grants, and effective capabilities." generatedAt={data.generatedAt} />
    {data.principals.length === 0 ? <p className="empty-state">No principals configured.</p> : <div className="item-list">{data.principals.map((principal) => <PrincipalDetails key={principal.id} principal={principal} />)}</div>}
  </>;
}
