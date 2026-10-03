import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadPolicies } from "@/app/api/policies/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { AutomationBanner, PolicyCard, policiesVerdict } from "@/components/policy-state";
import { Verdict } from "@/components/verdict";
import type { Policy } from "@/lib/policies";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const DESCRIPTION = "What KEEL does on its own when something changes, and the account it acts as.";

export default async function PoliciesPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.policiesPage);
  let data: { policies: Policy[]; automationDisabled: boolean; automationHaltedAt: string | null; haltFile: string; generatedAt: string };
  try {
    const response = await loadPolicies(new Request("http://localhost/api/policies", { headers: await headers() }));
    if (!response.ok) throw new Error("Policies unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader section="Settings" title="Policies" description={DESCRIPTION} /><DataUnavailable surface="Policies" /></>;
  }
  const paused = data.policies.some((policy) => policy.enabled && (policy.paused_at || policy.run_as_repair_required));
  // Roadmap task-92: an automatic roll-back policy that is off is turned on from a preview.
  const waiting = data.policies.filter((policy) => policy.action === "auto_remediate" && !policy.enabled).length;
  return <>
    <PageHeader section="Settings" title="Policies" description={DESCRIPTION} generatedAt={data.generatedAt} />
    <Verdict text={policiesVerdict(data.policies, data.automationDisabled)} tone={data.automationDisabled ? "critical" : paused ? "attention" : "good"} />
    <div data-layer="explanation">
      <AutomationBanner halted={data.automationDisabled} haltedAt={data.automationHaltedAt} haltFile={data.haltFile} now={data.generatedAt} />
      {waiting > 0 ? <p className="policy-preview-hint">{waiting === 1 ? "One policy that rolls back automatically is off." : `${waiting} policies that roll back automatically are off.`} Before it is turned on, KEEL shows what it would change and everything those changes depend on.</p> : null}
      {data.policies.length === 0
        ? <p className="empty-state">No policies are set up. KEEL only reports changes; nothing acts on its own.</p>
        : data.policies.map((policy) => <PolicyCard canEdit={access.capabilities.includes("policies")} key={policy.id} now={data.generatedAt} policy={policy} />)}
    </div>
  </>;
}
