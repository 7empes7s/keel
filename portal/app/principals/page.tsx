import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";

import { GET as loadPrincipals } from "@/app/api/principals/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { PeoplePage as PeopleBody } from "@/components/people/people-page";
import { Icon } from "@/components/shell/icons";
import { peopleCounts, peopleStatus } from "@/lib/people-view";
import type { PrincipalView } from "@/lib/principals";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const DESCRIPTION = "Who can use Keel and what each person can do.";

// People (portal audit, one design): everyone as one grouped list with count tiles
// that filter, a panel per person for roles and access, and "Add person" in the header.
export default async function PrincipalsPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.principalsPage);
  let data: { principals: PrincipalView[]; generatedAt: string };
  try {
    const response = await loadPrincipals(new Request("http://localhost/api/principals", { headers: await headers() }));
    if (!response.ok) throw new Error("Principals unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader section="Settings" title="People" description={DESCRIPTION} /><DataUnavailable surface="People" /></>;
  }
  const canUsers = access.capabilities.includes("users");
  const canRoles = access.capabilities.includes("roles");
  return <>
    <PageHeader
      actions={canUsers && canRoles ? <Link className="btn" href="/principals?new=1"><Icon name="plus" />Add person</Link> : undefined}
      description={DESCRIPTION}
      generatedAt={data.generatedAt}
      section="Settings"
      status={peopleStatus(peopleCounts(data.principals, data.generatedAt))}
      title="People"
    />
    <PeopleBody canRoles={canRoles} canUsers={canUsers} now={data.generatedAt} people={data.principals} />
  </>;
}
