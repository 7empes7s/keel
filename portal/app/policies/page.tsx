import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";

import { GET as loadPolicies } from "@/app/api/policies/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { PoliciesPage as PoliciesBody } from "@/components/policies/policies-page";
import { Icon } from "@/components/shell/icons";
import { ruleCounts, rulesStatus } from "@/lib/policy-view";
import type { Policy } from "@/lib/policies";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const TITLE = "Automatic rules";
const DESCRIPTION = "What Keel does on its own when something changes, and who it acts as.";

// Policies (portal audit, one design): the rules as one grouped list with count tiles
// that filter, Resume as the one amber action, and "New rule" in the header.
export default async function PoliciesPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.policiesPage);
  let data: { policies: Policy[]; automationDisabled: boolean; automationHaltedAt: string | null; haltFile: string; generatedAt: string };
  try {
    const response = await loadPolicies(new Request("http://localhost/api/policies", { headers: await headers() }));
    if (!response.ok) throw new Error("Policies unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Automation center" title={TITLE} /><DataUnavailable surface="Automatic rules" /></>;
  }
  const canEdit = access.capabilities.includes("policies");
  return <>
    <PageHeader
      actions={canEdit ? <Link className="btn" href="/policies?new=1"><Icon name="plus" />New rule</Link> : undefined}
      description={DESCRIPTION}
      generatedAt={data.generatedAt}
      section="Automation center"
      status={rulesStatus(ruleCounts(data.policies), data.automationDisabled)}
      title={TITLE}
    />
    <PoliciesBody canEdit={canEdit} haltFile={data.haltFile} halted={data.automationDisabled} haltedAt={data.automationHaltedAt} now={data.generatedAt} policies={data.policies} />
  </>;
}
