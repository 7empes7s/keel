import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";
import { GET as loadPolicies } from "@/app/api/policies/route";
import { PageHeader } from "@/components/page-header";
import { DataUnavailable } from "@/components/data-unavailable";
import { KillSwitchBadge, PolicyState } from "@/components/policy-state";
import type { Policy } from "@/lib/policies";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

export default async function PoliciesPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.policiesPage);
  let data: { policies: Policy[]; automationDisabled: boolean; generatedAt: string };
  try {
    const response = await loadPolicies(new Request("http://localhost/api/policies", { headers: await headers() }));
    if (!response.ok) throw new Error("Policies unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader eyebrow="Governance" title="Policies" description="Automation policies and their current state." /><DataUnavailable surface="Policies" /></>;
  }
  return <>
    <PageHeader eyebrow="Governance" title="Policies" description="Automation policies and their current state." generatedAt={data.generatedAt} />
    <KillSwitchBadge disabled={data.automationDisabled} />
    {data.policies.length === 0 ? <p>No policies configured.</p> : data.policies.map((policy) => <section key={policy.id}>
      <h2><Link href={`/policies/${policy.id}`}>{policy.name}</Link></h2>
      <PolicyState policy={policy} />
    </section>)}
  </>;
}
