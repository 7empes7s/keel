import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { GET as loadPolicy } from "@/app/api/policies/[id]/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { AutomationBanner, PolicyCard, policySentence, policyStateSentence } from "@/components/policy-state";
import { Verdict } from "@/components/verdict";
import type { Policy } from "@/lib/policies";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.policyPage);
  const { id } = await params;
  let response: Response;
  try {
    response = await loadPolicy(new Request(`http://localhost/api/policies/${encodeURIComponent(id)}`, { headers: await headers() }));
  } catch {
    return <><PageHeader section="Settings" title="Policy" description="This policy could not be read." /><DataUnavailable surface="This policy" /></>;
  }
  if (response.status === 404) notFound();
  if (!response.ok) return <><PageHeader section="Settings" title="Policy" description="This policy could not be read." /><DataUnavailable surface="This policy" /></>;
  const { policy, automationDisabled, generatedAt } = await response.json() as { policy: Policy; automationDisabled: boolean; generatedAt: string };
  const state = policyStateSentence(policy, generatedAt);
  return <>
    <PageHeader section="Settings" title={policy.name} description="What this policy does, acting as whom, and what it last did." generatedAt={generatedAt} />
    <Verdict text={`${state}. ${policySentence(policy)}`} tone={state === "Running" ? "good" : "attention"} />
    <div data-layer="explanation">
      <Link className="text-link back-link" href="/policies"><span aria-hidden="true">←</span> All policies</Link>
      <AutomationBanner halted={automationDisabled} now={generatedAt} />
      <PolicyCard canEdit={access.capabilities.includes("policies")} linkName={false} now={generatedAt} policy={policy} />
    </div>
  </>;
}
