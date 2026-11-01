import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { GET as loadPolicy } from "@/app/api/policies/[id]/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { pageTrail } from "@/lib/page-trail";
import { PolicyPage as PolicyBody } from "@/components/policies/policy-page";
import { RULE_KINDS, RULE_STATES, ruleKind, ruleState } from "@/lib/policy-view";
import type { Policy, PolicyAction } from "@/lib/policies";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { AnonymityNote } from "@/components/anonymity-note";
import { getAnonymitySetting } from "@/lib/anonymity";

const PARENTS = [{ href: "/rules", label: "Automatic rules" }];

// One rule's page: its state in the header, the sentence once, what it watches, does
// and acts as, its newest actions, and the controls.
export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.policyPage);
  const trail = await pageTrail("Automation center", PARENTS);
  const { id } = await params;
  let response: Response;
  try {
    response = await loadPolicy(new Request(`http://localhost/api/policies/${encodeURIComponent(id)}`, { headers: await headers() }));
  } catch {
    return <><PageHeader description="This rule could not be read." parents={trail.parents} section={trail.section} title="Automatic rule" /><DataUnavailable surface="This rule" /></>;
  }
  if (response.status === 404) notFound();
  if (!response.ok) return <><PageHeader description="This rule could not be read." parents={trail.parents} section={trail.section} title="Automatic rule" /><DataUnavailable surface="This rule" /></>;
  const { policy, actions = [], automationDisabled, generatedAt } = await response.json() as { policy: Policy; actions?: PolicyAction[]; automationDisabled: boolean; generatedAt: string };
  const state = RULE_STATES[ruleState(policy)];
  return <>
    <PageHeader
      description={`${RULE_KINDS[ruleKind(policy)].label}: what it watches, who it acts as, and what it did.`}
      generatedAt={generatedAt}
      parents={trail.parents} section={trail.section}
      status={{ tone: state.tone === "neutral" ? "low" : state.tone, label: state.label }}
      title={policy.name}
    />
    <AnonymityNote setting={await getAnonymitySetting()} />
    <PolicyBody actions={actions} canEdit={access.capabilities.includes("policies")} halted={automationDisabled} now={generatedAt} policy={policy} />
  </>;
}
