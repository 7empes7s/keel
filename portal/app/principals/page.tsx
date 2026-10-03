import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadPrincipals } from "@/app/api/principals/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { PrincipalDetails } from "@/components/principal-details";
import { Verdict } from "@/components/verdict";
import type { PrincipalView } from "@/lib/principals";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const DESCRIPTION = "Who can use KEEL, their roles and what each can do. Principals include people and system accounts.";

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
  const active = data.principals.filter((principal) => !principal.disabled_at && !principal.system_kind);
  const approvers = active.filter((principal) => principal.capabilities.includes("approve")).length;
  return <>
    <PageHeader section="Settings" title="People" description={DESCRIPTION} generatedAt={data.generatedAt} />
    <Verdict text={`${active.length} ${active.length === 1 ? "person can" : "people can"} use KEEL; ${approvers} can approve.`} tone={approvers === 0 ? "attention" : "good"} />
    <div className="item-list" data-layer="explanation">
      {data.principals.length === 0 ? <p className="empty-state">Nobody has been added yet.</p> : data.principals.map((principal) => (
        <PrincipalDetails
          canRoles={access.capabilities.includes("roles")}
          canUsers={access.capabilities.includes("users")}
          key={principal.id}
          now={data.generatedAt}
          principal={principal}
        />
      ))}
    </div>
  </>;
}
