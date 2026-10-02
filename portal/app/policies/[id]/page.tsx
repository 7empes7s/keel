import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { GET as loadPolicy } from "@/app/api/policies/[id]/route";
import { PageHeader } from "@/components/page-header";
import { DataUnavailable } from "@/components/data-unavailable";
import { PolicyState } from "@/components/policy-state";
import type { Policy } from "@/lib/policies";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  await requireReadAccess(DATA_SURFACES.policyPage);
  const { id } = await params;
  let response: Response;
  try {
    response = await loadPolicy(new Request(`http://localhost/api/policies/${encodeURIComponent(id)}`, { headers: await headers() }));
  } catch {
    return <DataUnavailable surface="Policy" />;
  }
  if (response.status === 404) notFound();
  if (!response.ok) return <DataUnavailable surface="Policy" />;
  const { policy } = await response.json() as { policy: Policy };
  return <>
    <PageHeader eyebrow="Governance" title={policy.name} description="Current policy configuration and automation state." />
    <PolicyState policy={policy} />
    <section aria-label="Policy record" className="policy-group policy-meta">
      <h3>Record</h3>
      <dl className="kv-grid"><dt>Policy ID</dt><dd>{policy.id}</dd><dt>Created by</dt><dd>{policy.created_by}</dd><dt>Created at</dt><dd>{policy.created_at}</dd></dl>
    </section>
  </>;
}
